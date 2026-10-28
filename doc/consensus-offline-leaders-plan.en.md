# Implementation Plan — Offline / Unresponsive Leaders without Accidental Forks

**Status:** design proposal (implementation plan) — **parameters approved 2026-10-26** (§10)
**Scope:** Avalon consensus (`src/chain.js`, `src/consensus.js`, `src/config.js`, `src/p2p.js`, `src/leaderStats.js`)
**Baseline analysed:** `feat/auto-force-finalize` @ `e15c1f0` (= PR #2, tag `v2.0.2` + the P2P catch-up fix; the `new_net` release line without Economy Fork `#13330000`)
**Target release:** `v2.1.0` (Layer S) and `v2.2.0` (Layer H) — see §8
**Language:** English (project convention for `doc/`)

---

## 0. Executive summary

Avalon already has a *crash-tolerant proposal layer* (a scheduled leader plus a fallback
ladder built from the most recent block producers) and a *voting finality layer* (2/3+
quorum over the active leaders). The chain therefore does **not** stop when one leader
disappears: the next block is produced by the previous miner after one extra block time.

What is missing is everything around that mechanism:

* the skip is **not attested**: `missedBy` is set by the producer, never validated, never
  used by consensus;
* the **finality quorum adapts to the wrong set**: `activeLeaders()` is derived from the
  *last 10 produced blocks* and only checks that a name is in the current shuffle, never
  that its node is alive. A leader that stops producing keeps being counted until 10 blocks
  have been produced without it — and production is strictly sequential (`minerWorker` is
  called from `addBlock` only), so **two leaders dying inside the same 10-block span leave a
  denominator of 5 and a threshold of 4 with only 3 signers, and the window can never drain:
  permanent halt** (force finalisation cannot help, it needs the same quorum). When the
  deaths are far enough apart to fall out of the window the chain does survive, but silently
  at the weakest safe configuration (3-of-5, with no record of who is missing);
* **force-finalisation can still pick different blocks on different nodes** (local candidate
  set + local clock ⇒ vote splitting / "fork risk" log path);
* **nothing punishes or replaces a dead leader**: a leader with fewer votes (`node_appr`)
  can never take the slot of a higher-ranked dead one, because the rotation set is fixed
  to the top `L` accounts by `node_appr`.

This plan introduces a **deterministic turn ladder** derived only from block data, an
**on-chain skip attestation** (`skips[]`, additive to the block), **digest-based absence
accounting**, **soft jailing without slashing**, **automatic replacement of a dead leader by
the next-ranked (lower-vote) leader**, and a **zero-fee wake-up** built from an *existing*
transaction type.

Two layers, because they have very different compatibility envelopes:

| Layer | Content | Consensus change | Old nodes |
|---|---|---|---|
| **S** (soft fork) | `skips[]` attestation, deterministic force-finalize, absence accounting, adaptive quorum, grace margin, future-block queue, wake-up | **none** — new nodes are *stricter*/different only in local policy; block validity rules are unchanged | keep validating the chain, never block the upgraded majority |
| **H** (hard fork, height-gated) | standby promotion into the rotation (lower-vote leader replaces a jailed one), canonical leader-set ordering, strict `skips` validation | **yes** — leader-set computation changes | must be upgraded before the activation height (flag day) |

Layer H is the part that literally delivers *"a lower-vote leader takes the place of a
higher-vote leader whose node is not working"*. Layer S is a prerequisite and can be
shipped and battle-tested while the chain is still halted; Layer H should be activated on
the same maintenance window because the network is already halted at block **13,320,067**.

**Non-goals:** slashing, permanent key removal, reward changes, changes to public
key/signature structures, transaction fee changes, reorg/fork-choice support.

---

## 1. Requirements and compliance matrix

| # | Requirement | How it is satisfied | Proof |
|---|---|---|---|
| R1 | **Deterministic on-chain, no fork.** No node may deactivate keys from local timeouts/latency; penalties and turn-skips must be state transitions derived from the chain (emptied slots recorded in the next validated block). | Skip sets are a pure function of `(schedule epoch, previous block miners, block metadata)`; jail/streak state is recomputed from `skips[]` + `miner` only; quorum eligibility (`lastTurn`) is chain-derived. The only wall-clock element is the `haltBreaker` (§6.3.1, enabled at `H_S` after drill G11), which changes *when* a node accepts an already-produced block — never validity, keys, or state. | §5.3, §6.1, §6.3, Appendix A; tests `skip-attestation`, `jail-state`, `quorum`, chaos G5/G6/G11 |
| R2 | **Maximum backward compatibility.** Minimal block-schema and state-DB changes; a soft-fork path where old nodes keep validating the main chain; no change to keys/signatures; only leader election / round-robin touched. | `skips[]` is an *optional additive* field covered by the existing V2 hash; old nodes hash it identically and ignore its semantics. No DB migration; one optional derived table. Leader-set changes are isolated in Layer H. | §4.1, §4.2, §8.1, §8.5; downgrade test G9 |
| R3 | **Minimal punitivity (soft jailing).** No slashing, no permanent removal; suspension only after `N` on-chain-proven consecutive missed turns; low-friction return (heartbeat or automatic). | Jail = *eligibility* flag only (rotation demotion / quorum exclusion). Balance, stake, keys untouched. `N = 30` consecutive turns (≈ 9 min). Auto-expiry after `J = 200` blocks with exponential re-jail backoff, plus a zero-fee heartbeat. | §6.2, §7.1, §7.2 |
| R4 | **Lower-vote leader replaces a dead higher-vote leader.** | `activeLeaderSet(h)` = top `L` by `(node_appr desc, name asc)` minus jailed, backfilled from a standby pool (`leaderStandbys`); the schedule epoch is regenerated every `L` blocks from that set, so the promoted leader gets *priority 1* slots. Un-jail reinstates the original leader; permanent retirement stays a governance action (`DISAPPROVE_NODE_OWNER`). | §6.4, §6.7; testnet G4 |

**Hard truth about R2 + R4:** the two cannot both hold in the strict sense. Reassigning a
*priority-1* slot to a node that has never produced cannot be expressed inside the old
validation envelope (proof in §3.3, Lemma 2). R2 is therefore satisfied by Layer S
(fully soft) and by Layer H's *staged roadmap*, while R4 is delivered by Layer H.
The plan is explicit about which rule is active at which height.

---

## 2. Baseline: how Avalon chooses and finalises blocks today

### 2.1 Code map (verified against `e15c1f0`)

| Mechanism | Location | Behaviour |
|---|---|---|
| Scheduled leader | `src/chain.js` `minerSchedule()` ~L691 | `rand = last 6 hex chars of block.hash`; `miners = generateLeaders(true,false,L,0)` (top `L` by `node_appr`); deterministic Fisher–Yates shuffle; padded with repeats if `< L` leaders. Recomputed **every `L` blocks** (`block._id % L === 0`, ~L294). |
| Priority-1 (scheduled) | `chain.js` ~L559 | `shuffle[(h-1) % L].name === miner` |
| Fallback ladder | `chain.js` ~L565 | the miner of block `h-1` has priority 2, `h-2` → 3, … up to `L`; `minerPriority = recency index + 1` |
| Early check | `chain.js` ~L585 | reject if `ts(h) - ts(h-1) < minerPriority · blockTime`; env escape hatch `SKIP_EARLY_CHECK_BLOCKS` (default `3889058` — a past incident) |
| Skip bookkeeping | `chain.js` ~L145 | producer sets `missedBy = shuffle[(h-1)%L].name` **only** when it is not the scheduled leader; never validated (`chain.js` ~L534 even misses the `cb(false)`) |
| Block hash | `chain.js` ~L812 | V2 = `sha256(JSON.stringify(block − {hash, signature}))` ⇒ **any extra field is hashed by old and new nodes identically** |
| Consensus rounds | `consensus.js` ~L170-330 | 2 rounds (`config.consensusRounds`), every leader pre-commits every valid block it sees, then commits |
| Quorum | `consensus.js` ~L74-95 | `max(3, floor(activeLeaders·2/3)+1)`, `+1` for observers; `activeLeaders()` = current shuffle + recent producers that are in the current shuffle |
| Force finalize | `consensus.js` ~L387-643 | local timer (`Date.now()`), local winner (earliest `ts`, then lowest hash), broadcast all candidates, collect votes, backoff `600/1200/2400/4800 ms`, **halt if no quorum** (`forceFinalizeFallback=false`) |
| Message signing | `consensus.js` ~L644 | consensus votes are valid only if the signer is in the **current** shuffle |
| Sync | `p2p.js` `recover()` ~L469 | forward-only, by height; a node that is behind adds blocks **without** consensus rounds |
| Leader index | `leaderStats.js` | optional (`LEADER_STATS=1`) counters `produced/missed` from `missedBy` |

### 2.2 Failure modes found (F)

| Id | Failure | Consequence | Fixed in |
|---|---|---|---|
| **F1** | `missedBy` is unvalidated and single-valued (only the scheduled leader, not the intermediate backups) | no trustworthy absence data; a leader can be blamed by anyone; no basis for jailing | S |
| **F2** | Quorum denominator comes from the last 10 *produced* blocks and ignores liveness (`getActiveLeaderKey` only checks membership in the current shuffle) | 2 leaders dying within the same 10-block span ⇒ denominator 5, threshold 4, 3 signers, frozen window ⇒ **permanent halt**; deaths far enough apart ⇒ silent 3-of-5 operation with no record of who is absent | S (§6.3) |
| **F3** | Force-finalize ranks candidates locally (`timestamp`, `hash`) and each node votes for *its own* local best | vote splitting despite agreement on the rules; the `forceFinalizeFallback` path can fork | S |
| **F4** | `maxDrift = 200 ms`: a block whose timestamp is 200 ms ahead of the local clock is **rejected forever**, and the sender is penalised via `recordBlockFailure` | clock-skew-induced divergence / peer banning | S |
| **F5** | `SKIP_EARLY_CHECK_BLOCKS` (hard-coded height `3889058`) is a binary escape hatch for a past early-block incident | a validation rule that can only be bypassed by an env var, not by chain evidence | S (grace margin + attested skips), H (strict) |
| **F6** | `generateLeaders()` sorts by `node_appr` only, over `Object.keys(cache.leaders)` (Mongo natural order) | **ties are not canonical**: two nodes can compute different top-`L` sets, hence different schedules | H (canonical order), S (diagnostics) |
| **F7** | `minerSchedule(block)` is recomputed at **restart** from the *current* `cache.accounts` (`main.js` ~L137-144) instead of the state at that block | a restart after an approval/disapproval in the current epoch yields a different schedule than the running nodes → priority-1 blocks at 3 s are rejected until the next epoch | S (persist the epoch schedule) |
| **F8** | No reorg / fork-choice; `recover()` is forward-only | any real divergence requires manual truncation (`scripts/auto_resolve_halt.sh`) or a DB restore | mitigated (deterministic ranking + quorum intersection), §5.5 |
| **F9** | A dead leader can never be replaced by the next-ranked (lower-vote) leader | the rotation keeps one slot per round permanently degraded (3 s → 6.5 s), and the dead account keeps its slot indefinitely | H |

### 2.3 Two lemmas that shape the design

**Lemma 1 (soft-fork envelope).**
A change is *soft* iff every block accepted by an upgraded node is also accepted by a
non-upgraded node. In `isValidNewBlock`, the only consensus-relevant checks are: field
types, `_id`/`phash` continuity, `timestamp ≤ localNow + 200 ms`, miner ∈
`{scheduled} ∪ {last L producers}` with `gap ≥ priority·blockTime`, then tx execution and
hash/signature. Anything that only *adds fields to the block* is inside the envelope,
because the V2 hash is computed over the received object (extra fields included) and old
nodes never inspect `missedBy`/`skips`. Anything that adds a **new rejection reason on
data an old producer emits** is *not* soft and must be height-gated after universal
upgrade.

**Lemma 2 (priority-1 reassignment requires a hard fork).**
Let `X = S(h)` be a leader that has been excluded from the new rotation and `Y` the
promoted standby. Under the old rules, `Y` is authorised only if `Y = S_old(h)` (it is
not: `S_old(h) = X`) or `Y` produced one of the last `L` blocks (a promoted standby has
produced **none**). Hence `Y`'s block is `unauthorized miner` for every old node.
Even if `Y` had produced recently, its recency index is `L-1`, so the old rule requires a
gap of `L·blockTime = 15 s`, while a priority-1 takeover is 3 s. **Conclusion:** the
rotation replacement (R4) is a height-gated consensus change; everything else is not.

---

## 3. Design overview

### 3.1 The turn ladder (canonical, chain-derived)

For every height `h = head + 1`, every node computes the same ordered candidate list:

```
schedule(h)  = the shuffle of the current epoch   // regenerated every L blocks
S(h)         = schedule(h)[(h - 1) mod L]         // priority 1
ladder(h)    = [ S(h) ]                            // p = 0
             ∪ [ miner(h-1), miner(h-2), … ]       // p = 1, 2, …  (dedup, skip self)
             ∪ [ standbys… ]                       // Layer H only, p = |above| …
candidate at position p may produce at ts(h-1) + (p+1)·blockTime   (+ grace if p ≥ 1)
```

This is *exactly* the priority rule the chain already enforces (Lemma 1); the plan only
makes it explicit, attestable and extensible. The ladder is a function of block history
only — no node-level liveness probe, no timer, no ping.

### 3.2 Layer S vs Layer H

| | Layer S — `v2.1.0` | Layer H — `v2.2.0` |
|---|---|---|
| `skips[]` in blocks | written, validated in **warn** mode | written, **strictly** validated |
| Force-finalize | deterministic ranking + candidate fetch | unchanged |
| Absence accounting | on-chain, per leader | same |
| Quorum | jail-aware (`E`) | same |
| Rotation | **unchanged** | top-`L` minus jailed + standbys |
| New tx types | none | none |
| Activation | all heights ≥ resume | `h ≥ H_standby` (first epoch boundary) |
| Old nodes | follow the chain; may lag, never block | must be upgraded (flag day) |

### 3.3 Parameters (canonical values; consensus parameters live in `config.history`)

| Name | Default | Meaning |
|---|---|---|
| `skipRecording` | `true` @ resume | producers must set `skips` (array, may be empty) |
| `skipStrict` | `false` → `true` @ `H_strict` | reject blocks whose `skips` ≠ canonical |
| `jailMissThreshold` (`N`) | `30` turns | consecutive proven misses → soft jail (≈ 9 min at 3 s) |
| `quorumEligibility` | `lastTurn` | a leader leaves the quorum denominator once its most recent scheduled turn was demonstrably skipped on-chain (no timer); `streak` (M turns) is available as the conservative alternative |
| `haltBreaker` | `true` @ `H_S` (after drill G11) | enable the recovery round of §6.3.1 |
| `haltBreakerMs` | `(L+2)·blockTime` = 21 s | no finalised block for this long ⇒ engage the recovery round |
| `haltBreakerQuorum` | `remaining` | the recovery round requires the **unanimity of the remaining eligible set** (≥ 3) |
| `jailBlocks` (`J`) | `200` blocks | first jail duration (≈ 12 min) |
| `jailBackoffMax` | `4` | re-jail durations `J·{1,2,4}` |
| `leaderStandbys` (`R`) | `5` | standby pool size (Layer H) |
| `standbyEnabled` | `false` → `true` @ `H_standby` | Layer H rotation replacement |
| `skipGraceMs` | `500` | extra wait for substitutes (producer-side only) |
| `quorumMin` | `3` | absolute floor for the adaptive quorum |
| `pendingBlockMaxMs` | `2·L·blockTime` = 30 s | max hold time for a future-dated block |
| `heartbeatTxType` | `18` (`ENABLE_NODE`) | wake-up envelope (existing tx) |

`L`, `blockTime`, `consensusRounds`, `maxDrift` are unchanged (`5`, `3000`, `2`, `200`).

---

## 4. Phase 1 — State machine and data structures

### 4.1 Block schema: one optional additive field

```js
// src/chain.js
class Block {
    constructor(index, phash, timestamp, txs, miner, missedBy, dist, burn, signature, hash, skips) {
        …
        if (missedBy) this.missedBy = missedBy     // kept: old indexers, /block docs, leaderStats
        if (skips && skips.length) this.skips = skips   // NEW: ordered, distinct, length ≤ L + R
        …
    }
}
```

* **Write**: in `mineBlock()` replace the single
  `if (scheduler !== NODE_OWNER) newBlock.missedBy = scheduler` with
  `newBlock.skips = ladder.slice(0, p)` and `newBlock.missedBy = newBlock.skips[0]`
  (keeps every existing consumer working).
* **Hash**: nothing to do — `calculateHashForBlock` V2 hashes the whole object; old and new
  nodes compute the same digest from the same JSON. `calculateHashV1` (legacy
  `blockHashSerialization: 1`) is untouched and remains valid for historical blocks.
* **Persist**: `blocks.appendBlock()` / Mongo `insertOne()` are schema-less (BSON /
  document). No migration, no index change.
* **Read**: `blocks.read()` / `findOne()` return the field as-is; `/block/:number` exposes
  it automatically (add the apidoc line).
* **Bounds**: `Array.isArray`, `length ≤ L + R`, every entry a valid account name
  (`accountMinLength..accountMaxLength`), no duplicates, `miner ∉ skips`.

Estimated diff: **~15 lines** in `chain.js`, 1 line of apidoc.

### 4.2 Derived state: `src/leaderHealth.js` (no DB migration)

A new in-memory module, rebuilt from `chain.recentBlocks` at startup and updated in
`addBlock()` / `rebuildState()` next to `leaderStats.processBlock(block)`.

```js
{
  // per leader
  produced, missed, lastProduced,
  streak,            // consecutive proven missed turns
  jail: { active, untilBlock, level, lastJailBlock, probation },
  lastSkip: { height, position, jailedAtTheTime }
}
```

* Feed: `block.miner`, `block.skips` (fallback `[block.missedBy]` for pre-activation
  blocks), and the schedule epoch that was in force at that height.
* Rebuild cost: one pass over `recentBlocks` (≤ `ecoBlocks` = 9 600) — negligible, no I/O.
* Persistence: **none required**. The optional `leaderStats` extension (`LEADER_STATS=1`,
  collection `leaders`) can store `jailed/until/level/streak` for the dashboard; it is
  derived and rebuildable.
* This module never mutates `accounts`, `balances`, `node_appr`, or keys.

### 4.3 One small optional persistence addition (fixes F7)

At each epoch boundary (`block._id % L === 0`) persist the *computed* epoch schedule:

```js
state: { _id: 'schedule:<h0>', leaders: [names…], set: [names…], jailSnapshot: {...} }
```

* Written once every `L` blocks (≈ 15 s), pruned to the last 2 epochs.
* Read by `main.js` `startDaemon()` instead of recomputing from the live cache ⇒ a
  restarted node recomputes the **same** schedule as the running nodes.
* Derived, rebuildable, ignored by old nodes ⇒ **no compatibility impact**. If the
  document is missing (old DB), fall back to today's recomputation and log a warning.
* Can be disabled with `SCHEDULE_PERSIST=0` (diagnostic).

### 4.4 Config and activation

All consensus-affecting parameters go into `src/config.js` `history` (same mechanism as
`forceFinalize` @ 13 925 000; note that the `100: { forceFinalize: true }` entry currently
present in the S4 worktree is a **testnet-only local patch, not in `v2.0.2`**):

```js
// Layer S — additive field + local policy, safe at any height (ship enabled by default)
H_S = 13325000           // ≈ 5 000 blocks after the resume block 13 320 067
{ skipRecording: true, skipStrict: false, quorumMin: 3, quorumEligibility: 'lastTurn',
  jailMissThreshold: 30, jailBlocks: 200, jailBackoffMax: 4, skipGraceMs: 500,
  haltBreaker: true, haltBreakerMs: 21000 }   // off-switch: env HALT_BREAKER=0

// Layer H — strict validation + rotation replacement (flag day, all nodes upgraded)
H_H = 13400000           // first epoch boundary applied: ceil(H_H / L) · L
{ skipStrict: true, standbyEnabled: true, leaderStandbys: 5,
  canonicalLeaderOrder: true }
```

All values above are the **approved** ones (§10); the alternatives are recorded there.

`config.read(blockNum)` already applies entries cumulatively in numeric order and logs
`Hard Fork #<height>`; `chain.addBlock()` reloads the config after every block. The
**effective** height of a rotation change is the first epoch regeneration at or after
`H_H`, i.e. `ceil(H_H / L) · L` — deterministic and independent of restarts (the epoch
document makes it explicit).

### 4.5 API / observability

| Endpoint | Change |
|---|---|
| `/block/:n` | documents `skips` |
| `/schedule` | adds `epoch`, `set`, `standbys`, `jailed` (additive keys; existing `shuffle` untouched) |
| `/leader/:acc` | adds `streak`, `jailed`, `jailUntil`, `jailLevel` (additive) |
| `/allminers` | adds `rank`, `eligible`, `jailed` (additive) |
| **new** `/consensus` | `{ head, epoch, set, standbys, ladder, eligible, quorum, jail[], lastSkips[] }` — the single page an operator looks at during an incident |
| **new** `/debug/statehash` | `sha256(derived state + last 100 block hashes)` for cross-node determinism checks (testnet chaos tests, §8.3) |

### 4.6 Files touched (Phase 1)

`src/chain.js` (Block, mineBlock, minerSchedule, generateLeaders), `src/leaderHealth.js`
(new), `src/config.js`, `src/main.js` (startup), `src/http/consensus/index.js` (new),
`src/http/schedule/index.js`, `src/http/leader/index.js`, `src/http/allminers/index.js`,
`src/http/index.js`, `src/leaderStats.js`, `doc/api-indexing.md`.

---

## 5. Phase 2 — "Skipped turn" determination

### 5.1 The rule

> A turn at height `h` is **proven skipped** for candidate `X` iff a *finalised* block at
> `h` records `X ∈ skips`, where `skips` is exactly the prefix of `ladder(h)` that precedes
> the actual miner, and the block satisfied the gap rule for its own position.

No timer, no timeout, no liveness probe. The evidence is inside the block, and the block is
final because it is in the chain.

### 5.2 Producer algorithm (`chain.js`)

```js
const ladder = chain.leaderLadder(height)           // §3.1, pure
const p = ladder.indexOf(process.env.NODE_OWNER)
if (p === -1) return                                // not my turn and not a backup
const dueAt = prev.timestamp + (p + 1) * config.blockTime
                       + (p > 0 ? config.skipGraceMs : 0)   // producer-side only
// wait until dueAt (existing minerWorker), then:
newBlock.skips    = ladder.slice(0, p)              // ← attested empty slots
newBlock.missedBy = newBlock.skips[0]               // ← legacy field
```

`minerWorker()` changes from "find my recency index" to "find my ladder index" (same
numbers, one function, one test). The `+500 ms` grace applies **only to substitutes**: a
healthy scheduled leader keeps the 3 s cadence, while a leader whose clock is 0–500 ms slow
is no longer pre-empted by an eager backup (anti-griefing, §6.6). Because the rule is a
*minimum* gap, a longer wait is always compatible with old nodes.

### 5.3 Validator algorithm (`isValidNewBlock`)

**Unchanged (always, both layers):**
`_id`/`phash` continuity, field types, `gap ≥ (p+1)·blockTime` with `p` derived exactly as
today, `miner` authorised (`p` exists).

**Layer S (`skipStrict: false`):** if `skips` is present, recompute the canonical prefix
and log a warning on mismatch; **never reject**. This is the canary: a mismatch means two
nodes disagree on the ladder (F6/F7), and operators must see it *before* Layer H.

**Layer H (`skipStrict: true`):**
1. `skips` must be present (even `[]`).
2. `skips` must equal `ladder(h).slice(0, p)` exactly (order, content, distinct, no miner).
3. `missedBy`, when present, must equal `skips[0]`.
4. Jail-administrative skips are part of the canonical prefix (the jailed leader is still
   in `ladder(h)` until its last production falls out of the `L`-block window); the
   accounting in §6.1 distinguishes them.

Old nodes perform none of 1–4, so Layer H is a genuine hard fork and is height-gated.

### 5.4 Timestamps, drift, and the pending queue (fixes F4)

`maxDrift` stays 200 ms (changing it is not needed and would be a config divergence), but
the **reaction** changes:

| Situation | Today | New |
|---|---|---|
| `ts > now + maxDrift` | `logr.error('timestamp from the future')`, `cb(false)`, `recordBlockFailure(sender)` | keep the block in `consensus.pending[height]`, re-check at `ts - maxDrift - now` (bounded by `pendingBlockMaxMs = 30 s`), **no peer penalty**; drop silently after the bound |
| `ts` too old (`< prev.ts`) | invalid | unchanged |
| vote freshness | `±2·blockTime` around the local clock | `±(consensusRounds+2)·blockTime` (consensus votes are not block content; a wider window removes skew-induced vote dropping without weakening anti-replay, which is provided by the `processed` dedupe) |

This removes the last **local-clock** input from block validity, satisfying R1.

### 5.5 Deterministic force-finalisation (fixes F2/F3)

Force finalisation is kept as the **safety net** but becomes view-synchronising instead of
view-guessing:

1. **Rank is chain-derived, not local.** `rank(candidate) = (p, timestamp, hash)` with `p`
   from `ladder(candidate._id)`. Every node computes the same rank for the same block.
2. **Fetch missing candidates.** New P2P message `t:8 FF_FETCH {height, hashes[]}` answered
   with `t:9 FF_BLOCK {block}` (unknown types are ignored by old nodes — the `switch` has
   no `default`, so this is P2P-backward-compatible). The receiver validates the block via
   `consensus.round(0, …)` and only then feeds it to `_resolveForceFinalize`.
3. **Monotone votes.** A node may change its FF vote only towards a strictly better rank
   (never away). This prevents oscillation and closes the "each node votes for its own
   local winner" split.
4. **Same winner everywhere.** Because `rank` is a total order over the union of candidates,
   all nodes that can see the candidates converge on the same winner; the quorum is then
   about *availability*, not about *choice*.
5. **No quorum ⇒ halt, never fork.** `forceFinalizeFallback` stays `false` (default). The
   halt is now rare (only when candidates are unavailable, i.e. network partition), and it
   is *recoverable* by the existing `auto_resolve_halt.sh`/runbook without truncation in
   most cases.
6. **Timer anchoring.** Keep the current chain-time anchor
   (`latestBlock.timestamp + blockTime · (L + rounds + 2)`), but the timer only *triggers*
   the protocol; no state transition depends on when it fires.

### 5.6 Why this cannot fork

* Two different blocks at the same height can exist, but finality still requires `q` distinct
  signers (quorum intersection): with `q = 4` of `L = 5`, two disjoint quorums would need
  `4 + 4 = 8` signatures from at most `5 + b` signers, i.e. `b ≥ 3` colluding keys; with the
  degraded `q = 3 / E = 3` configuration it would need **all** remaining signers.
* The skip attestation changes **no** validity rule in Layer S and only *adds* rejection
  reasons for upgraded producers in Layer H (a producer running the new code always
  satisfies them, because it derives the same ladder from the same chain).
* A non-upgraded producer in Layer H can at worst stall *itself*: its block lacks `skips`,
  the upgraded quorum rejects it, and the node then catches up via `recover()` (which
  bypasses voting). It cannot drag the chain onto a different branch.

---

## 6. Phase 3 — Soft jailing and absence counting

### 6.1 Absence accounting (pure function of the chain)

```js
// applied in chain order; `jailStateAt(h-1)` is known because it was derived from h-1
processBlock(block) {
  for (const name of skipsOf(block)) {          // canonical order
    if (name === miner(block)) continue         // impossible by rule, defensive
    if (jailedAt(name, block._id - 1)) continue // administrative skip, not a miss
    streak[name]++
    missed[name]++
    lastSkip[name] = block._id
    if (streak[name] >= N) jail(name, block._id)
  }
  const m = block.miner
  streak[m] = 0                                 // any production clears the streak
  jailState[m].active = false                   // producing clears the jail (soft)
  jailState[m].level  = 0
  produced[m]++
}
```

* `skipsOf(block)` = `block.skips` if present, else `block.missedBy ? [block.missedBy] : []`
  — this makes historical blocks (pre-activation) usable for the rebuild without a
  migration.
* Only *consecutive* misses matter (reset on production) — no "30 misses over 3 months".
* A miss is counted **only** from a finalised block, and only when the producer had a
  legitimate window (gap rule) — the two conditions that make it "proven on-chain".
* No balance, `node_appr`, key or account field is touched. **No slashing.**

### 6.2 Jail state machine

```
ACTIVE --(N consecutive misses)--> JAILED(level=1, until=h+J)
JAILED --(h = until)-------------> PROBATION (back in the set, must produce in its next turn)
PROBATION --(produces)-----------> ACTIVE (level=0)
PROBATION --(misses its turn)----> JAILED(level=min(level+1, jailBackoffMax), until=h+J·2^level)
JAILED --(valid heartbeat)-------> ACTIVE (level=0)        §7.2
```

| Transition | Trigger | Deterministic? |
|---|---|---|
| JAILED | `streak ≥ N` (`N = 30` turns ≈ 9 min) | yes (block data) |
| Expiry | `head ≥ until` | yes (block height, not wall clock) |
| Re-jail | probation turn missed | yes |
| Wake-up | tx type 18 from the leader's account inside a finalised block | yes (block content) |
| Clear | any block produced by the leader | yes |

### 6.3 Effect 1 — adaptive quorum (liveness, Layer S)

Today there are **two** formulas, and both are keyed on a set that includes absent leaders:
`tryNextStep` uses `floor(2·active/3) + 1` (min 3, `+1` for observers, `~L79`) and
`_getQuorumThreshold` uses `min(4, max(ceil(2·active/3), 3))` (`~L413`); they coincide for
`active ≤ 5` but live in two places. `active = activeLeaders().length`, where
`activeLeaders()` = the scheduled leader + miners of the last `2L = 10` blocks that are in
the current shuffle. `getActiveLeaderKey()` only checks *membership*, never liveness, so a
dead leader keeps its place in the denominator for as long as the chain keeps producing
without it — and it stops producing exactly when the quorum is lost. That asymmetry is the
whole problem (F2).

**Eligibility (no timer, pure chain data).** A leader is *eligible* unless its most recent
scheduled turn in the current epoch was demonstrably skipped:

```
lastTurn(X) = max{ h ≤ head : S(h) = X }             // from the epoch schedule (chain data)
absent(X)   = (miner(lastTurn(X)) ≠ X)               // its turn was taken by a backup
eligible(h) = { X ∈ epoch set : ¬absent(X) }
E           = |eligible(h)|
q           = min(4, max(3, E))                      // one helper, both paths
q_observer  = min(q + 1, |epoch set|)
```

Rationale for `lastTurn` instead of a streak counter: a single hiccup is harmless
(`E = 4 ⇒ q = 4`, unchanged), while two leaders that missed their most recent turn give
`E = 3 ⇒ q = 3`, which is the smallest change that restores liveness. It is exact, it needs
no new state, and it is evaluated *at finalisation time* on data already in the chain.

**Safety.** A fork needs two disjoint signer sets of size `q`; with `b` Byzantine extra votes
that requires `2q ≤ E + b`.

| Offline leaders | E | q | Fork requires | Chain survives? |
|---|---|---|---|---|
| 0 | 5 | 4 | `b ≥ 3` → 3 of 5 colluding | yes |
| 1 | 4 | 4 | `b ≥ 4` → all 4 remaining colluding | yes (4 online = quorum) |
| 2 | 3 | 3 | `b ≥ 3` → all 3 remaining colluding | **yes (new)** |
| 3 | 2 | 3 | unreachable | no — deterministic halt |

So the adaptive quorum never lowers the bar below "the whole remaining eligible set must
collude": at full strength a fork needs 3 of 5, in the degraded states it needs *all* the
remaining signers. At `E = 4` this is strictly *stronger* than today (today `active = 4`
yields `q = 3`, i.e. 2 colluding signers would already be enough). `quorumMin` stays `3`
(= unanimity of the remaining three), which is exactly what makes `q = 3` safe.

**Why a different `q` cannot fork.** Quorum is not part of block validity. A node with a
higher `q` finalises later and then catches up through `recover()`, which bypasses voting.
Two nodes can only disagree if they finalise *different blocks of the same height*, and that
is prevented by §5.5 (synchronised candidate set + deterministic rank + single monotone
vote), not by the threshold value.

**Vote counting** must be de-duplicated by name (`Set`), and `tryNextStep` /
`_getQuorumThreshold` must call the same helper so the two paths can never diverge again.

#### 6.3.1 The one time-triggered element: recovery round (`haltBreaker`)

`lastTurn` only sees misses that were *recorded*. If two leaders die within the same round,
the chain freezes at `head` before any block can record their absence — and nothing can be
recorded afterwards, because production is strictly sequential (`minerWorker(block)` is
called from `addBlock(block)` only, `chain.js` ~L296). No deterministic rule can break this
freeze: a node that has stopped answering is, by definition, not represented in the chain
until someone else produces a block, and nobody can produce one.

Therefore — and this is the **only** place where wall-clock time enters the design — a node
that has seen no finalised block for `haltBreakerMs = (L+2)·blockTime = 21 s` starts a
*recovery round* for `head+1`:

1. Collect candidates for `head+1` for `2·blockTime` (normal gossip, plus `FF_FETCH`).
2. Rank them deterministically (§5.5) and pick the winner `W`.
3. Sign **one** vote for `W` (single, monotone: never for two different blocks at a height).
4. Finalise `W` when it carries the signature of **every** member of the remaining eligible
   set (`unanimity`, `|signers| = E_remaining ≥ 3`), and only then.

Why this is fork-safe: after step 1 all nodes that can communicate share the *same*
candidate set, hence compute the same `W`; honest nodes cast **one** vote, for `W`. A
competing block `W'` therefore needs `E_remaining` signatures that nobody honest can supply,
i.e. it needs **all** remaining signers to be dishonest. If unanimity is not reached, the
node does **not** finalise: it alerts and halts (R2: halt rather than fork), and an operator
restarts the missing node.

This changes *when* a node accepts a block, **never** *which* block is valid, and it never
touches keys, balances, `node_appr` or the rotation — so it is compatible with R1, while
being honest that it is a local liveness policy, not a consensus rule. **Approved** (§10.7):
enabled at `H_S`, after the testnet drill G11 has passed. Because it is local policy it also
has an environment off-switch (`HALT_BREAKER=0`), so it can be suspended during an incident
without a release.

### 6.4 Effect 2 — rotation replacement by lower-vote leaders (R4, Layer H)

This is the mechanism requested explicitly: **an account with fewer votes (`node_appr`)
takes the slot of a higher-vote account whose node is not producing.**

```
activeLeaderSet(h) =
   sort(all accounts with pub_leader and node_appr > 0,
        by node_appr DESC, then name ASC)      // canonical, fixes F6
   remove accounts with jail.active at h
   take the first L                                 // priority set = rotation
standbyPool(h) = the next R non-jailed accounts    // promotion queue
```

* The set is evaluated **at each epoch regeneration** (`block._id % L === 0`), from the
  derived state at that block ⇒ all nodes compute the same set.
* `minerSchedule()` shuffles `activeLeaderSet` (seeded by the epoch block hash, unchanged);
  a promoted standby therefore becomes `S(h)` with **priority 1 (3 s)** — a real
  replacement, not a last-resort backup.
* Padding: if the eligible set has fewer than `L` names, `minerSchedule` already repeats
  names to keep the period `L` (index math, `(h-1) % L`, stays untouched — deliberately, to
  minimise churn).
* The demoted leader stays a legitimate *backup* while it is still in the last `L`
  producers, so a node that comes back cannot be blocked from producing an emergency block;
  this preserves the "no permanent removal" property.
* `ladder(h)` in Layer H also gains the `standbyPool` tail (`p = L+1 …`), so even a
  simultaneous failure of the whole top-`L` rotation can be covered after ~21–30 s without
  any local decision.
* **Reinstatement:** when the jail expires, the original leader (still higher `node_appr`)
  returns to `activeLeaderSet` at the next epoch, and the standby goes back to the pool.
  To avoid churn, the re-jail duration doubles each time (`J, 2J, 4J`, capped).
* **Permanent retirement** is *not* automatic: the existing governance transaction
  `DISAPPROVE_NODE_OWNER` (type 2) lowers the dead leader's `node_appr`, after which the
  standby outranks it permanently. Jailing is soft by design; hard removal remains a
  governance decision.

### 6.5 Safety analysis (Layer H)

| Risk | Analysis | Mitigation |
|---|---|---|
| Standby promotion forks old nodes | Lemma 2 | height-gated, universal upgrade (§8.2) |
| Set changes mid-epoch | schedule is only regenerated at epoch boundaries; jail state evaluated once per epoch for the *set*, but the quorum uses the live `lastTurn` eligibility | documented; epoch schedule persisted (§4.3) |
| Quorum reduced to `q = 3` | a fork needs 3 signatures of 3 remaining ⇒ **all** remaining signers dishonest; `2q > E + b` in every reachable state (§6.3) | `quorumMin: 4` switch + alert when `E < 4` |
| `haltBreaker` finalises a block another node would not | it only fires on the synchronised candidate set with a single monotone vote, and requires unanimity of the remaining eligible set (§6.3.1); it can be disabled | enabled after drill G11; env off-switch `HALT_BREAKER=0` |
| Ping-pong between a returning leader and its standby | one stutter per un-jail cycle | exponential re-jail backoff |
| A fast standby repeatedly pre-empts a slow scheduled leader | producer grace (+500 ms) + NTP requirement + canonical order | §6.6, runbook check |
| Whole rotation jailed | `standbyPool` tail in the ladder | §6.4 |
| Set becomes empty | `minerWorker` already halts with a fatal log | alert, manual intervention (unchanged) |

### 6.6 Anti-griefing

* **Grace margin** (`skipGraceMs = 500`): substitutes wait an extra 500 ms, so a scheduled
  leader with sub-second clock skew is never recorded as missing. Only producers respect
  it (old nodes see a *longer* gap, which is always valid). No cost in the healthy path.
* **Clock hygiene** is an operational requirement (NTP/chrony) and will be checked by the
  runbook; the pending-block queue (§5.4) removes the hard failure when it slips.
* **Blame needs a finalised block**; nobody can mark a leader absent with an unsigned
  message. A single malicious producer cannot jail anyone alone: it needs a finalised block
  whose canonical prefix contains the victim, and a finalised block needs a quorum.
* **No economic effect**: jail changes eligibility only. There is nothing to steal by
  jailing a competitor, which keeps the incentive to game it at zero.

### 6.7 Worked example (simulated with the real rule, `L = 5`, `blockTime = 3000`)

Leader `B` is offline; `A, C, D, E` are healthy. Ladder positions and timing:

| height | S(h) | producer | p | t (s) | `skips` |
|---|---|---|---|---|---|
| 1 | A | A | 0 | 3.0 | `[]` |
| 2 | **B** | A | 1 | 9.5 | `["B"]` |
| 3 | C | C | 0 | 12.5 | `[]` |
| 4 | D | D | 0 | 15.5 | `[]` |
| 5 | E | E | 0 | 18.5 | `[]` |
| 6 | A | A | 0 | 21.5 | `[]` |
| … | | | | | |
| 2·k | **B** | A | 1 | … | `["B"]` |

* One missing leader costs **+3.5 s per round** (18.5 s instead of 15 s): the chain keeps
  running, no halt, no fork.
* `B` reaches `streak = 30` after **30 rounds ≈ 555 s ≈ 9.25 min** → jailed (`J = 200`
  blocks).
* Layer H from the next epoch: the set becomes `A, C, D, E` (+ top standby), the round
  returns to **15 s**, and `B`'s slot is gone. `B` returns → heartbeat → reinstated at the
  next epoch.
* Two missing leaders (`B`, `D`): round = 22 s; as soon as one block records both skips,
  `absent(B) ∧ absent(D)` ⇒ `E = 3`, `q = 3` ⇒ the chain continues with `A, C, E` (no
  timer, no waiting window). If the two die **in the same round**, no block can record it
  first: that is the freeze of §6.3.1, broken by the recovery round (unanimity of `A, C, E`).
* Three missing leaders (`B, D, E`): `E = 2 < quorumMin` ⇒ deterministic halt, alert, no
  fork. Recovery = bring one node back or restart it (§7).
* Today (for comparison): the same two deaths inside the 10-block window keep the
  denominator at 5 / threshold 4 with 3 signers ⇒ **permanent halt**.

---

## 7. Phase 4 — Wake-up

### 7.1 Automatic (default, no operator action)

Jail expiry at `until = h + J·2^level` is a pure height comparison. The node is
reinstated into `activeLeaderSet` (Layer H) or back into the expected-voter set (Layer S)
with a **probation**: one missed turn re-jails it with doubled duration. Nothing to sign,
nothing to send. Works even if the operator lost the account key.

### 7.2 Heartbeat transaction (fast path, zero fee, existing tx type)

**Design constraint discovered in the code:** a zero-amount `TRANSFER` (type 3) is
**invalid** — `transfer.js` calls `validate.integer(amount, canBeZero=false, canBeNegative=false)`.
A new transaction type would be a hard fork. Therefore the heartbeat uses an **existing**
type that old nodes already execute:

> **`ENABLE_NODE` (type 18) re-sent with the account's current `pub_leader` key.**
> `enableNode.js` performs `$set: { pub_leader: <same key> }` (idempotent) and
> `cache.addLeader()` (idempotent). No fee, no balance change, no `node_appr` change,
> no reward effect. Old nodes execute it exactly as today.

New nodes add one rule in `leaderHealth.processBlock()`: a type-18 tx from account `X`
inside a finalised block **immediately** clears `X.jail` and `X.level` (deterministic:
time of effect = the containing block, not the receive time).

Requirements and operational notes:
* The tx must be signed by a key authorised for type 18 on that account. If the node only
  holds the leader key, authorise it once with `NEW_KEY`/`ACCOUNT_AUTHORIZE`
  (`types: [18]`) — or run the heartbeat from the account owner's wallet.
* Idempotent and self-only: an account can only wake itself up, so there is no spam vector
  against others.
* If the operator never sends it, the automatic expiry still works (at most `J` blocks of
  delay).

**Alternative envelope** (same properties, if type 18 is undesirable for a given operator):
`USER_JSON` (type 6) with `json.node.hb = "<last block hash>"`. It is a plain profile
update for old nodes. Do **not** use a 0-value transfer.

### 7.3 Operator procedure (goes into the runbook)

1. On restart, the node rebuilds `leaderHealth` from `recentBlocks`; `/consensus` shows
   `jailed: true, until: <height>` immediately (no waiting for gossip).
2. Wait until the node is caught up (`/` head == peers' head).
3. Send the heartbeat (CLI `node scripts/heartbeat.js --account <name> --key <priv|file>`).
4. Verify `/consensus` → `jailed: false`, and that the node appears in `/schedule` at the
   next epoch.
5. If the node is unhealthy, do nothing: the automatic expiry handles it, and the standby
   keeps the slot until then.

### 7.4 Determinism check

`leaderHealth` is a fold over finalised blocks: restart, replay, crash recovery and
`rebuildState` all produce the same state. Heartbeat effects are applied at block
application time (same place as `leaderStats`), never on message receipt. The
`/debug/statehash` endpoint exposes it for verification.

---

## 8. Phase 5 — Deployment and network backward compatibility

### 8.1 Stage plan

| Stage | Release | Content | Activation | Upgrade requirement |
|---|---|---|---|---|
| **S0** | `v2.1.0` | `skips[]` write + warn-mode validation, deterministic FF + fetch, pending-block queue, grace margin, `leaderHealth`, `/consensus`, `/debug/statehash`, schedule persistence | immediately (all heights) | none (additive) |
| **S1** | `v2.1.x` | adaptive quorum (`q = min(4, max(3, E))` on `lastTurn` eligibility), jail accounting active, wake-up, `haltBreaker` | `H_S = 13 325 000` | leaders (quorum is local policy) |
| **H1** | `v2.2.0` | strict `skips` validation | `H_strict = 13 400 000` | **5/5 leaders + all public validators** |
| **H2** | `v2.2.0` | `activeLeaderSet` + standby promotion + canonical order | `H_standby = 13 400 000` (effective `ceil(H/5)·5`) | same flag day |

Why this order: S0/S1 can be observed for weeks without any risk of rejecting an old
producer; H1/H2 are the only rules that can reject a block an old node would accept, and
they are bundled with the feature that actually needs them.

### 8.2 Readiness gates (hard, not aspirational)

Before `H_strict`/`H_standby`:

1. **Version census**: every current epoch member and every standby reports the new
   `version` string in `NODE_STATUS` (`p2p.js` already carries it). Gate: 5/5 leaders and
   100 % of known public validators. Exception: a leader already jailed/absent is excluded
   from the census (it cannot produce anyway).
2. **Schedule agreement**: `/debug/statehash` and `/schedule` identical across all upgraded
   nodes for ≥ 1 000 consecutive blocks (catches F6/F7 *before* H).
3. **Warn-mode clean**: zero `skips mismatch` warnings for ≥ 1 000 blocks.
4. **Fallback drill**: on testnet, run G1–G12 (§8.3) with the exact release artifact,
   including G11 (`haltBreaker` recovery) and G12 (conservative halt).
5. **Rollback artifact**: pre-`H` DB snapshot + `blocks.bson` copy on every node, per the
   existing runbook §6.

If any gate fails, `H_strict`/`H_standby` are postponed by editing the heights **before**
the release is deployed. Heights in `config.history` are immutable once passed, so the
decision must be made before the flag day (this mirrors the `13 925 000` pattern already
used for `forceFinalize`/`consensusSigVersion`).

### 8.3 Test matrix

**Unit (`node test/<file>.js`, assert-only, no DB):**

| File | Cases |
|---|---|
| `test/skip-attestation.js` | ladder for `L = 1…7`; dedupe; duplicate schedule names; missing `recentBlocks` at genesis; canonical prefix for `p = 0…L`; `skips` tampering rejected in strict / warned in soft; `gap` boundary (`+1 ms`, `-1 ms`); grace only for `p ≥ 1` |
| `test/jail-state.js` | streak counting, reset on production, administrative skips, `N` boundary, expiry, probation re-jail, backoff cap, heartbeat clears jail, replay determinism (same blocks, shuffled arrival order) |
| `test/quorum.js` | `E = 0…5`, `q` monotonicity, `q = 4` with 1 absent, `q = 3` with 2 absent, `lastTurn` eligibility (skip recorded / not recorded / epoch boundary), observers' `+1` capped, duplicate-name dedupe, hostile `activeLeaders` (sybil) |
| `test/force-finalize.js` (extend) | rank total order, fetch path, monotone votes, no-quorum halt, `fromNow` guard, retry cap (existing tests stay green) |
| `test/standby.js` | canonical `(node_appr, name)` ordering, promotion at the epoch boundary, reinstatement, empty pool, padding when `< L` |

**Integration (`docker/testnet`, 5 leaders + 2 standbys, always with
`-f docker-compose.yml -f docker-compose.migrate.yml`):**

| Id | Scenario | Expected |
|---|---|---|
| G1 | 1 leader down 60 blocks | chain continues at 3.5 s avg, `skips` correct, no jail |
| G2 | 1 leader down 200 blocks | jailed at 30 turns, `E=4/q=4`, no halt; heartbeat → back in the next epoch |
| G3 | 2 leaders down 400 blocks | jailed, `E=3/q=3`, chain continues (documented trade-off); both return, rotation restored |
| G4 | top-5 leader down 200 blocks (Layer H) | standby #6 enters at the next epoch, produces at 3 s, all nodes accept; original returns → reinstated |
| G5 | 3/2 partition for 100 blocks | majority finalises; minority resyncs via `recover()`; **no divergent height** (`statehash` equal) |
| G6 | clock skew ±5 s on two nodes | blocks held in `pending` then accepted; no rejection, no peer ban, no divergence |
| G7 | equivocation (same key on two nodes) | deterministic rank picks one block; no fork; both blocks logged |
| G8 | force-finalize with asymmetric views | fetch path converges on the same winner; no halt |
| G9 | one **old** node during S1 / during H1 | S1: follows the chain normally; H1: stalls, resyncs automatically, never forks |
| G10 | all 5 leaders down | chain halts deterministically (no fork), recovers when ≥ 3 return |
| G11 | 2 leaders killed in the *same* round (`docker kill` both) | freeze is detected after 21 s; recovery round converges on one candidate, finalised with the unanimity of the remaining 3; **no fork**, chain resumes without operator action |
| G12 | 2 leaders killed, `HALT_BREAKER=0` (off-switch) | deterministic halt + alert (no fork); restarting one node resumes the chain — this is the conservative fallback behaviour with the breaker disabled |

**Chaos / soak:** replay 100 000 blocks with a random 0–3 leaders offline, random clock
skew, random restarts; assert identical `/debug/statehash` on all nodes at every checkpoint;
assert `jailed` transitions match the expected deterministic timeline.

### 8.4 Cutover during the current halt (operational advantage)

The network is halted at block **13 320 067** (since 2026-06-27) and `forceFinalize` is
inactive until **13 925 000**. That makes the upgrade the *cheapest possible* flag day:

1. All operators upgrade to `v2.1.x` **before** the resume. Because the chain is halted,
   there is no "mixed version" window at all: the resume block is produced by new code.
2. `skipRecording` is active from the first resumed block. Old nodes can still be started
   and will hash/index the new blocks correctly (downgrade path).
3. S1 activates at `H_S = 13 325 000` (≈ 5 000 blocks after resume ≈ 5 h at 3 s): enough
   time to observe the new fields, fast enough to matter.
4. H1/H2 at `H_strict = 13 400 000` (≈ 80 000 blocks ≈ 3 days after resume): a full
   observation window with warn-mode clean and the version census complete.
5. `v2.0.x` remains runnable read-only: it will follow the chain, which is exactly the R2
   property we want to be able to demonstrate (and it is test G9).

Note: the `100: { forceFinalize: true }` entry present in the S4 worktree is a testnet
patch; it must not ship.

### 8.5 Rollback

| Situation | Action | Data loss |
|---|---|---|
| S0/S1 misbehaves | redeploy the previous tag; the chain is unchanged (no new validity rule), old code ignores `skips` | none |
| H1/H2 must be undone **after** activation | full coordinated rollback: stop all nodes, restore the pre-`H` DB + `blocks.bson` snapshot, redeploy the old tag (runbook §6) | blocks produced after `H` are lost (bounded by the snapshot age) |
| Split detected | **do not truncate automatically**; `auto_resolve_halt.sh` is last-resort only, and it now refuses repeated truncation | per script |

Because Layer H is height-gated and its gate is evaluated before the release ships, the
"rollback after activation" case is an operational failure, not an expected path. The
recommended posture (same as PR #2's `forceFinalizeFallback: false`) is: **halt rather than
fork**.

### 8.6 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A standby is promoted while its node is actually broken | low | one wasted slot per round until `N` misses | ladder fallback; jail cascade |
| Quorum `q = 3` under a Byzantine participant | low | a fork needs **all** remaining signers to be dishonest (3 of 3); with 1–2 Byzantine among them the honest majority still votes one block | `quorumMin: 4` switch; alert on `E < 4` |
| Operators skip the heartbeat and wait `J` | medium | ~12 min of rotation loss | automatic expiry is the default; alerting |
| `node_appr` tie order differs across nodes (F6) | **high today** | schedule mismatch, priority-1 stalls | canonical order in H; `/debug/statehash` gate in S |
| Restart recomputes a different schedule (F7) | medium | priority-1 stalls after restart | epoch schedule persistence |
| Disk/BSON growth from `skips` | negligible | ~50–100 B/block | — |
| Docker testnet bootstrap DB wiped by missing `-f docker-compose.migrate.yml` | known | test-only | documented in the test scripts |

---

## 9. Implementation checklist (file by file)

| # | File | Change | Phase |
|---|---|---|---|
| 1 | `src/chain.js` | `Block.skips`; `leaderLadder()`; `minerWorker` uses ladder + grace; `mineBlock` writes `skips`/`missedBy`; `isValidNewBlock` warn/strict; `minerSchedule`/`generateLeaders` canonical order + `activeLeaderSet` + standby pool; persist epoch schedule | 1-3 |
| 2 | `src/leaderHealth.js` | **new** — streaks, jail state machine, heartbeat rule, derived rebuild | 1-3 |
| 3 | `src/consensus.js` | unified `_getQuorumThreshold` with `E`; deterministic `rank`; `FF_FETCH`/`FF_BLOCK` handling; monotone votes; `haltBreaker` recovery round (§6.3.1); pending-block queue; vote freshness window | 1-2 |
| 4 | `src/p2p.js` | `MessageType.FF_FETCH = 8`, `FF_BLOCK = 9` (old nodes ignore unknown types); no peer penalty for future-dated blocks | 2 |
| 5 | `src/config.js` | `history` entries `H_S`, `H_strict`/`H_standby` with the parameters of §3.3 | 1 |
| 6 | `src/main.js` | load the persisted epoch schedule; warn when missing | 1 |
| 7 | `src/leaderStats.js` | persist `jailed/until/level/streak` when `LEADER_STATS=1` | 1 |
| 8 | `src/http/consensus/index.js` | **new** `/consensus` | 1 |
| 9 | `src/http/debug/statehash.js` | **new** `/debug/statehash` | 1 |
| 10 | `src/http/schedule|leader|allminers` | additive fields + apidoc | 1 |
| 11 | `scripts/heartbeat.js` | **new** — send `ENABLE_NODE` with the current leader key | 3 |
| 12 | `test/skip-attestation.js`, `test/jail-state.js`, `test/quorum.js`, `test/standby.js` | **new**, assert-only | 1-3 |
| 13 | `test/force-finalize.js`, `test/audit-fixes.js` | extend, keep green | 2 |
| 14 | `docker/testnet/*` | G1–G12 scripts + `statehash` comparison | 4 |
| 15 | `doc/mainnet-deployment-and-rollback.md`, `doc/migration-runbook-no-econs.en.md` | new stages, gates, heartbeat procedure | 4 |
| 16 | `doc/leader-101.md` | explain soft jail / standbys to operators | 4 |

Estimated effort: **S0+S1 ≈ 10–14 engineering days** (incl. tests), **H1+H2 ≈ 6–8 days**,
**testnet soak ≈ 5 days**. Critical path: `leaderHealth` + `chain.js` ladder, then the
quorum unification, then the standby set.

`eslint` baseline is `1 pre-existing error` (`src/http/auth/index.js:86`), 244 warnings — keep
it unchanged.

---

## 10. Decisions — approved 2026-10-26

All parameters below are **decided** and are the values referenced by §3.3, §4.4, §6 and §8.
The alternatives are kept for the record (re-opening a decision requires a new height entry
in `config.history`, or the environment off-switch where noted).

| # | Parameter | **Approved** | Why / alternative rejected | Reversible? |
|---|---|---|---|---|
| 10.1 | `quorumMin` | **3** | at `E = 3` the quorum is the unanimity of the remaining three, so a fork needs all of them colluding; rejecting `4` because it would halt the chain with 2 dead leaders | yes, new height entry |
| 10.2 | `N` (`jailMissThreshold`) | **30 turns** (≈ 9 min) | long enough to survive a reboot/deploy, short enough to free the slot the same hour; the quorum no longer depends on `N` (it uses `lastTurn`) | yes, new height entry |
| 10.3 | `J` (`jailBlocks`) | **200 blocks** (≈ 12 min), `jailBackoffMax = 4` | first jail short, then `200/400/800` to stop ping-pong with a node that keeps flapping | yes, new height entry |
| 10.4 | `leaderStandbys` (`R`) | **5** | covers a mass failure of the whole top-`L`; standbys never produce or vote unless promoted, so the steady-state cost is only a longer ladder tail (max takeover 30 s) | yes, new height entry |
| 10.5 | `skipStrict` (Layer H) | **strict** at `H_strict` | makes `skips[]` consensus-relevant, so a schedule divergence is rejected immediately instead of producing silent gaps; gated by §8.2 (5/5 leaders + all public validators) | no, after the height (rollback = DB restore) |
| 10.6 | Activation heights | **`H_S = 13 325 000`**, **`H_strict = H_standby = 13 400 000`** | ≈ 5 h and ≈ 3 days after the resume block 13 320 067; the rotation change applies at `ceil(H/5)·5`. Confirm the numbers with the 5 leader operators before the release ships | no, after the height |
| 10.7 | `haltBreaker` | **on** at `H_S`, `haltBreakerQuorum = remaining` (never below 3) | recovers a same-round double death automatically in 21 s; fork-safe because it needs unanimity of the survivors on a synchronised candidate set. **Gate: testnet drill G11 must pass first.** Local policy ⇒ off-switch `HALT_BREAKER=0` | yes, environment switch |

**Consequences for the release plan**

* Only 10.5 and 10.6 are irreversible once the height is passed: they are the two items that
  must be frozen before the `v2.1.x` artifact is published (§8.2).
* 10.1–10.4 are consensus-visible parameters but can be changed later through a new entry in
  `config.history` at a future height — no client change required.
* 10.7 is local policy: it can be turned off/on per node at any time without any height.

**Still open (not part of this plan's scope):** the operator-side items tracked separately —
the `v2.0.3` tag after PR #2, the `README.md` diff review, the IT runbook mirror commit, and
the S4 worktree patch (`100: { forceFinalize: true }`, widened `masterDaoTxs`) which must
never ship.

---

## Appendix A — Reference algorithms (pseudo-code)

```js
// ---------- shared, pure ----------
function scheduleEpoch(h) {           // epoch start is the last multiple of L
    return Math.floor(h / config.leaders) * config.leaders
}

function activeSet(h) {               // Layer H; Layer S returns generateLeaders(L)
    const all = accountsWithLeaderKey()                    // cache.accounts
        .filter(a => a.node_appr > 0)
        .sort((a, b) => b.node_appr - a.node_appr || (a.name < b.name ? -1 : 1))
    const alive = all.filter(a => !leaderHealth.isJailed(a.name, h))
    return {
        set: alive.slice(0, config.leaders),
        standbys: alive.slice(config.leaders, config.leaders + config.leaderStandbys)
    }
}

function ladder(h) {
    const sched = chain.schedule                             // epoch schedule
    const out = []
    const s = sched.shuffle[(h - 1) % config.leaders]
    if (s) out.push(s.name)
    for (let i = 1; i <= config.leaders; i++) {
        const b = chain.recentBlocks[chain.recentBlocks.length - i]
        if (!b) break
        if (out.indexOf(b.miner) === -1) out.push(b.miner)
    }
    if (config.standbyEnabled)                              // Layer H tail
        for (const st of sched.standbys || [])
            if (out.indexOf(st.name) === -1) out.push(st.name)
    return out
}

function dueAt(h, p) {
    return chain.getLatestBlock().timestamp + (p + 1) * config.blockTime
             + (p > 0 ? config.skipGraceMs : 0)
}

// ---------- quorum (one helper, used by tryNextStep and _getQuorumThreshold) ----------
function isAbsent(name, head) {          // pure chain data, no timer
    const t = lastScheduledTurn(name, head)          // max h ≤ head with S(h) = name
    if (t === null) return false                     // never scheduled yet in this epoch
    return chain.blockAt(t).miner !== name
}

function quorumThreshold(head) {
    const set = chain.schedule.set || []                          // epoch set
    const E = set.filter(n => !isAbsent(n, head)).length
    const q = Math.min(4, Math.max(config.quorumMin, E))
    return { q: consensus.isActive() ? q : Math.min(q + 1, set.length), E }
}

// ---------- producer ----------
function tryMine(h) {
    const l = ladder(h), p = l.indexOf(NODE_OWNER)
    if (p < 0) return
    setTimeout(() => chain.mineBlock(), Math.max(0, dueAt(h, p) - Date.now()))
}

// ---------- validator (after the existing field/continuity checks) ----------
function validateSkips(block, p) {
    if (!config.skipRecording) return true
    if (!Array.isArray(block.skips)) return !config.skipStrict   // warn mode tolerates
    const expected = ladder(block._id).slice(0, p)
    const ok = block.skips.length === expected.length
        && block.skips.every((n, i) => n === expected[i])
        && new Set(block.skips).size === block.skips.length
        && block.skips.indexOf(block.miner) === -1
    if (!ok && config.skipStrict) return false
    if (!ok) logr.warn('skips mismatch at #' + block._id, block.skips, expected)
    return true
}
```

## Appendix B — parameter reference

| Parameter | Value | Unit | Consensus? | Activation |
|---|---|---|---|---|
| `L` (`leaders`) | 5 | leaders | yes (schedule) | unchanged |
| `blockTime` | 3000 | ms | yes | unchanged |
| `consensusRounds` | 2 | rounds | yes | unchanged |
| `maxDrift` | 200 | ms | local policy | unchanged |
| `skipRecording` | true | bool | yes (additive field) | `H_S` |
| `skipStrict` | false→true | bool | yes (new rejection) | `H_strict` |
| `skipGraceMs` | 500 | ms | producer only | `H_S` |
| `N` (`jailMissThreshold`) | 30 | turns | yes (derived state) | `H_S` |
| `quorumEligibility` | `lastTurn` | mode | local policy | `H_S` |
| `haltBreaker` | true | bool | local policy | `H_S` (env `HALT_BREAKER=0` to disable) |
| `haltBreakerMs` | 21 000 | ms | local policy | `H_S` |
| `J` (`jailBlocks`) | 200 | blocks | yes | `H_S` |
| `leaderStandbys` | 5 | accounts | yes | `H_standby` |
| `quorumMin` | 3 | votes | local policy | `H_S` |
| `pendingBlockMaxMs` | 30 000 | ms | local policy | `H_S` |
| `heartbeatTxType` | 18 | tx type | no (existing tx) | `H_S` |

## Appendix C — code references (baseline `e15c1f0`)

* `src/chain.js`: `Block` 22, `prepareBlock` 68, `mineBlock` 127, `minerWorker` 228,
  schedule regeneration 294, validation 499-598, early check 585, `minerSchedule` 691,
  `generateLeaders` 723, `calculateHashForBlock` 812, `rebuildState` 906.
* `src/consensus.js`: `activeLeaders` 47, threshold 74, `tryNextStep` 69, `round` 170,
  `endRound` 274, `scheduleForceFinalize` 387, `_forceFinalize` 420,
  `_resolveForceFinalize` 489, `_applyForceFinalize` 600, `verifySignature` 644.
* `src/config.js`: `blockTime` 26, `leaders` 66, `maxDrift` 90, `forceFinalize` 180,
  `forceFinalizeFallback` 185, `history` 188-203, `read` 205.
* `src/p2p.js`: `MessageType` 46, `NEW_BLOCK` 348, `BLOCK_CONF_ROUND` 392, `recover` 469.
* `src/leaderStats.js`: `processBlock` 17, `getWriteOps` 74.
* `src/transactions/transfer.js`: `amount` strictly positive 12 (`canBeZero = false`).
* `src/transactions/enableNode.js`: idempotent `pub_leader` `$set` + `cache.addLeader`.
* `src/blocks.js`: append-only BSON + 8-byte index (schema-less).
* `src/main.js`: schedule bootstrap on restart 88-99, `startDaemon` 136-144.
