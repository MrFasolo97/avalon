# Offline / unresponsive leaders — prototype implementation and testnet run

This document records the implementation and live run of the offline-leader
jail slice described in `doc/consensus-offline-leaders-plan.en.md`.

## 1. What the slice implements

* **Layer S (soft fork):** producers write a `skips[]` attestation in every
  block; absence is counted from those on-chain attestations only. The quorum
  is adaptive: `q = min(quorumCap, max(quorumMin, E))`, where `E` is the number
  of eligible leaders (jailed leaders and leaders whose last scheduled turn was
  proven skipped are excluded).
* **Soft jail:** after `N` proven misses a leader is suspended from the rotation
  for `J` blocks; each re-jail doubles the duration up to a cap. No slashing, no
  key removal.
* **Standby promotion:** when a leader is jailed, the next epoch rebuilds the
  shuffle from the non-jailed candidates; standbys enter the rotation.
* **Heartbeat un-jail:** the existing `ENABLE_NODE` transaction (type 18) is
  re-sent as a no-fee, idempotent heartbeat that clears the jail immediately.
* **Halt breaker:** the only wall-clock element. If a block is produced but
  cannot gather the chain-derived quorum, the breaker finalises it after a
  timeout provided the live eligible signers are a *majority* of the eligible
  set (`floor(E/2)+1`), so two conflicting blocks at the same height cannot
  both be finalised under a partition.
* **Per-height commit lock:** a node commits at most one block per height; the
  only override is an explicit halt-breaker recovery round. The lock is
  persisted to disk so a crash + restart cannot cause double-signing. This
  prevents two competing blocks at the same height from both gathering full
  quorums when visibility is asymmetric.
* **Mainnet-like simulation harness** — `test/simulation.js` is a discrete-event
  simulator that drives the real `src/leaderHealth.js` kernel with compressed
  time (`blockTime=10 ms`, `N=30`, `J=200`, `leaderStandbys=5`).

## 2. Code map

| file | role |
|------|------|
| `src/leaderHealth.js` | pure kernel: ladder, attestation, jail state, quorum, commit-lock decision, breaker threshold |
| `src/chain.js` | `skips[]`, `jailState()`, `leaderLadder()`, `minerSchedule()`, `minerWorker()` re-anchor fix |
| `src/consensus.js` | adaptive quorum, halt breaker with majority threshold, per-height commit lock |
| `src/commitLockStore.js` | persistent JSONL store for the per-height commit lock |
| `src/config.js` | env-driven jail/quorum/commit-lock params in `history[0]` |
| `src/main.js` | loads commit locks from disk before joining consensus |
| `src/http/leaderhealth/index.js` | diagnostic endpoint `/leaderhealth` |
| `test/leader-jail.js` | 26 pure-function unit tests |
| `test/simulation.js` | mainnet-like discrete-event simulator |
| `docker/testnet/docker-compose.jail.yml` | isolated 5-node testnet |
| `docker/testnet/scripts/jail-demo.sh` | driver for baseline/kill/observe/wake |

## 3. Parameters used on the testnet

```
LEADERS_OVERRIDE=3        # rotation = dtube + top 2 miners
QUORUM_MIN=1              # testnet carve-out: genesis has a single leader
QUORUM_CAP=4
JAIL_MISS_THRESHOLD=3     # N = 3 misses
JAIL_BLOCKS=20            # J = 20 blocks
JAIL_BACKOFF_MAX=4
LEADER_STANDBYS=2
STANDBY_ENABLED=1
SKIP_STRICT=0             # Layer S: warn only
SKIP_GRACE_MS=500
HALT_BREAKER=1
HALT_BREAKER_MS=15000
HEARTBEAT_TX_TYPE=18
COMMIT_LOCK=1             # default on in this branch
```

## 4. Topology

One bootstrap/master node (`dtube`) + four miner nodes (`miner1`–`miner4`).
`dtube` is always in the rotation because its genesis `node_appr` is larger
than the miners'. With `LEADERS_OVERRIDE=3` the active rotation is
`[dtube, miner1, miner2]` and `[miner3, miner4]` are the standby pool. Each
node has its own Mongo database (`avalon`, `avalon_miner1`, …) on a shared
Mongo process.

## 5. Runbook

```bash
cd /tmp/opencode/avalon-jail/docker/testnet
docker compose -p avalon-jail -f docker-compose.jail.yml up -d --build
# wait for setup to complete, then:
./scripts/jail-demo.sh baseline
./scripts/jail-demo.sh kill     # kills miner2
./scripts/jail-demo.sh observe  # watch E/q and skips
./scripts/jail-demo.sh wake     # restart miner2 + heartbeat
```

## 6. Expected sequence

1. Baseline: 5-node rotation, `E=3 q=3`.
2. Kill `miner2`: its turns are skipped, blocks contain `skips: ['miner2']`,
   `E` drops to 2, `q` drops to 2.
3. After 3 misses `miner2` is jailed; at the next epoch `miner3` is promoted.
4. If `miner3` is also killed, the same cascade repeats: `miner4` is promoted.
5. Wake `miner2`: heartbeat clears the jail; it re-enters the rotation at the
   next epoch boundary.

## 7. Evidence

Run of 2026-10-26 on the isolated `avalon-jail` testnet (`quorumMin=1`, `N=3`,
`J=20`, `backoffMax=4`, `skipStrict=false` on the demo, `haltBreakerMs=15000`,
`blockTime=3000`, standbys `[miner3, miner4]`). Heights are chain heights.

### 7.1 Single failure — leader `miner2` killed

| height | producer | `skips[]` | E | q | note |
|--------|----------|-----------|---|---|------|
| 107 | miner1 | `[miner2]` | 3 | 3 | first miss, `haltBreaker: recovery round ... 2/3 eligible signers` |
| 111 | miner1 | `[miner2]` | 3 | 3 | |
| 112 | miner1 | `[miner2]` | 3 | 3 | 3rd miss → jailed at the next epoch |
| 117 | epoch rebuild | — | 3 | 3 | `shuffle [miner1, dtube, miner3]`, `standby [miner4]`, `jailed [{miner2, until:132}]` |

The 3 misses were attested in the blocks produced by the substitute (`missedBy` +
`skips`), so the jail decision is a pure function of the chain: no local timeout
was used to remove the key.

### 7.2 Cascading failure — the promoted standby (`miner3`) killed too

`miner3` was killed right after block 125 (its last production). It was the
standby promoted at epoch 117, i.e. the exact "the replacement is dead as well"
case.

| height | producer | `skips[]` | E | q | note |
|--------|----------|-----------|---|---|------|
| 127 | miner1 | `[miner3]` | 3 | 3 | first miss; one `haltBreaker` recovery round (15 s) |
| 130 | dtube | `[miner3]` | 2 | 2 | quorum dropped with the eligible set |
| 142 | dtube | `[miner3]` | 2 | 2 | 3rd miss → jailed `until 162` |
| 146–162 | **miner4** | — | 2 | 2 | last standby promoted into the rotation and producing |

So the answer to "what if the replacement is dead too" is: the same algorithm
runs again — skip attested on-chain → quorum shrinks `3 → 2` in lockstep → last
standby promoted. The chain never stopped (blocks 128-163 are 3 s apart) and the
only cost is one recovery round per newly-dead leader.

### 7.3 Jail expiry, re-jail and backoff

| height | event |
|--------|-------|
| 132 | `miner2` jail (20 blocks) expires → back in the shuffle |
| 134, 137, 139 | `miner2` skipped again (3 misses) → jailed #2 `until 179` (40 blocks = `J × 2`) |
| 162 | `miner3` jail expires → back in the rotation |
| 164 | `miner3` heartbeat (`ENABLE_NODE`, type 18) included in a block |
| 165, 166 | `miner3` still scheduled, missed while resyncing (streak 1) — the substitute produced |
| 169+ | `miner2` back in production after its own heartbeat cleared the jail before expiry |
| 219 | steady state: all 5 nodes report `ladder [miner2, miner1, dtube, miner3, miner4]`, `jailed []`, `E=3 q=3` |

### 7.4 Two defects found by the run (both fixed in the branch)

1. **`haltBreakerMs > blockTime` starves the miner.** After a recovery round the
   block is applied ~15 s late; every node then computed a negative delay and the
   old `Slow performance detected, will not try to mine next block` guard returned
   *without rescheduling* → chain frozen at height 107. Fixed by anchoring the
   ladder on `max(lastBlock.timestamp, chain.scheduleAnchor)` (set on recovery) and
   re-anchoring from "now" instead of giving up.
2. **Restarting every node leaves no armed timer** (pre-existing Avalon
   behaviour): mining only resumes inside `addBlock`, so a full restart needs a
   kick (`GET /mineBlock`). Operational note, unrelated to the jail logic.

### 7.5 Re-entry and the two-blocks-at-the-same-height race

Jail re-entry cannot change *who* is scheduled for a height, because:

* `jailState()` is a pure function of the recent blocks, so two nodes at the same
  tip compute the same jail state and the same ladder;
* the epoch shuffle is rebuilt only at epoch boundaries, so no node can gain or
  lose a slot mid-epoch;
* the receiver — not the producer — validates the right to produce
  (`positionOf(ladder, miner) !== -1` and `timestamp - prev >= (position+1) *
  blockTime`), so a node that thinks it has a turn while the rest of the network
  does not simply gets its block rejected.

Before the commit lock, the run produced genuine **collisions** (two valid
blocks at the same height, same parent), and they were resolved identically on
every node by the deterministic rule (earliest timestamp):

```
[bootstrap] Block collision detected at height 163, the leaders are: [['dtube', ...], ['miner1', ...]]
[bootstrap] Block collision detected at height 164, the leaders are: [['miner1', ...], ['dtube', ...]]
[miner4]    Block collision detected at height 166, the leaders are: [['miner4', ...], ['miner1', ...]]
```

At height 164 **both** competing blocks carried the *same* signatures in both
rounds (`0: [dtube, miner1]`, `1: [dtube, miner1]`): a node signed every valid
candidate at `tip+1`, so both blocks reached a full quorum. In that run every
node saw both candidates and picked the earliest, so there was no split — but
with asymmetric visibility (partition, latency) a node that sees only one
candidate would finalise it while the others finalise the other. That is the
real fork surface, and it is a pre-existing Avalon property that the halt
breaker (which lowers the threshold to the observed signers) widens.

Related: the skip attestation is time-based (`skipGraceMs=500`), so a *slow*
leader can be attested as skipped while its block exists (exactly what happened
at 164). This is why a node coming back from a restart can be skipped — and
re-jailed — while it is still resyncing.

## 8. Known limitations of the prototype

* No height gating: the new rules apply from any height. On mainnet they must be
  activated at `H_S` / `H_strict` / `H_standby` (plan §8).
* The jail state is rebuilt from a bounded window (`leaderHealthLookback`); a jail that
  began before the window is approximated as "not jailed". The production version keeps a
  checkpointed index.
* `skipStrict` is off, so a producer that lies about its skips is only logged.
* The halt breaker finalises with the *signers it observed*: it is safe against a single
  crashed leader, but it is not a substitute for the operator-verified `remaining` set of
  the production design (plan §6.3.1).
* Standbys can produce only through the ladder tail; they become full consensus
  participants at the epoch boundary, when they enter the shuffle.
* Jailed leaders are still counted by `activeLeaders()` for the force-finalize path; FF is
  disabled on this testnet, so the paths do not interact here.
* The per-height commit lock prevents a node from committing two different blocks
  at the same height, but it does not prevent a node that *crashed and restarted*
  from double-signing at a height it had already committed before the crash.
* `skipGraceMs=500` is shorter than a restart/resync: a slow leader can be
  attested as skipped while its block is still in flight. Production needs a
  grace that scales with measured peer latency.
* The testnet nodes share one Mongo process but use separate databases, so a
  genuine chain split would appear as different blocks at the same `_id` in
  `avalon_miner*.blocks`. The partition test below checks exactly that.

## 9. Network-partition test (commit-lock validation)

Goal: verify that a partition does **not** produce two different finalized
blocks at the same height. With `commitLock` enabled, a node commits at most one
hash per height; any two quorums of the live eligible set must intersect, and
the intersection node is on only one side of the partition, so the other side
cannot reach quorum.

### 9.1 Setup

Five nodes (`dtube`, `miner1`–`miner4`), `E=5`, `q=4`, `commitLock=true`.
Partition at height 656/658: disconnect `miner2` and `miner3` from
`avalon-jail_default`.

### 9.2 During the partition

| side | nodes | head after ~50 s | outcome |
|------|-------|------------------|---------|
| A | `dtube`, `miner1`, `miner4` | ~671 | progressed via halt breaker when a disconnected leader was scheduled |
| B | `miner2`, `miner3` | 658 | stalled: with 3 missing leaders the breaker refuses (`missing > 2`) |

Side B containers kept running but logged `dns lookup failed for bootstrap`.

### 9.3 Collision observed on side A

At height 659 side A produced two valid blocks:

```
[bootstrap] Block collision detected at height 659: [['dtube', ...], ['miner1', ...]]
[bootstrap] commit lock: refusing to commit block 659#e6551f79 by miner1,
            already committed 1c59d201 by dtube
[miner1]    commit lock: refusing to commit block 659#e6551f79 by miner1,
            already committed 1c59d201 by dtube
[miner4]    commit lock: refusing to commit block 659#e6551f79 by miner1,
            already committed 1c59d201 by dtube
```

The second candidate was rejected; every live node committed the same block.

### 9.4 After healing

`miner2` and `miner3` were reconnected. They did not resume automatically
(their DNS cache stayed stale), so they were restarted. After restart they
synced to side A's chain. A cross-DB comparison of heights 659–720:

```
NO MISMATCHES: all 5 DBs agree on every block from 659 to 720
```

Conclusion: under this partition the chain did **not fork**; the majority side
kept finalising, the minority side halted, and after reconnection every node
converged to the same history.

## 10. The dangerous case: 2|2 partition with `E=4`

With `quorumCap=4` and `E=4`, the normal quorum is `q=4`. The original breaker
rule (`signers >= 2 && missing <= 2`) allows each half of a 2|2 partition to
finalise a *different* block at the same height, producing a real chain split.

### 10.1 Reproducing the split (old breaker rule)

Test setup: `LEADERS_OVERRIDE=4`, `E=4`, `q=4`, `commitLock=true`.
Partition: side A = `{dtube, miner1}`, side B = `{miner2, miner3}`, `miner4`
isolated.

After giving side B a `/mineBlock` kick, both sides produced independently:

```
Side A (avalon DB):   122 dtube, 123 miner1, 124 miner1, ...
Side B (miner2 DB):   122 miner2 dtube, 123 miner2 miner1, 124 miner3, ...
```

The two sides had **different hashes at the same heights** (122-133). The commit
lock prevented individual nodes from signing both candidates, but because the
sides were disjoint there was no intersection node to stop them: each side had
exactly 2 eligible signers, and the old breaker accepted 2-of-4.

### 10.2 Fix: majority threshold in the breaker

The breaker now requires a *majority* of the eligible set:

```js
breakerThreshold(E) = Math.floor(E / 2) + 1
E=3 -> 2    E=4 -> 3    E=5 -> 3
```

Two majorities of the same set always intersect; with the per-height commit
lock, the intersection node cannot commit two different blocks, so a partition
cannot finalise conflicting blocks at the same height.

### 10.3 Re-running the 2|2 test (fixed breaker)

Same topology, new rule. Both sides logged:

```
haltBreaker: recovery not possible at height 122
  (signers=2/4 need>=3 missing<=1), halting instead of forking
```

No block was produced beyond the common tip (121). After removing the iptables
rules and reconnecting the nodes, the chain resumed from the same history:

```
NO MISMATCHES: all 5 DBs agree on every block from 122 to 150
```

### 10.4 Implications for the production design

The production plan must use the majority breaker threshold, not a fixed
"2 missing" rule. With `leaders=5`, `quorumCap=4`, `quorumMin=3`:

| situation | E | normal q | breaker needs | behaviour |
|---|---|---|---|---|
| all healthy | 5 | 4 | 4 | finalises normally |
| 1 leader missing | 5 | 4 | 3 | breaker finalises with 3 signers |
| 2 leaders missing | 5 | 4 | 3 | breaker finalises with 3 signers |
| 2|2 split after 1 jail | 4 | 4 | 3 | **both sides halt** — no fork |

This preserves liveness for single/double failures while preventing a split in
the worst partition case.

