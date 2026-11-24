# Avalon Mainnet — Deployment (Layer S/H) and Rollback Runbook

**Type:** operational runbook
**Target release:** the certified **Layer S/H** tag **`v2.2.0`** — the merge of the
`feat/auto-force-finalize` release fixes into `feat/view-change` (S and H ship together in
this cutover). **Freeze the tag before publishing**: `package.json.version` must match it
exactly, because the G-1 census reads `/version` and `NODE_STATUS`.
**From:** branch/line `new_net` (what mainnet runs today, halted) **plus** the intervening
consensus work — see the companions below
**Companions:**
`doc/consensus-offline-leaders-plan.en.md` (design + §8 gates, §10 decisions),
`doc/consensus-single-quorum-and-locks.en.md` (S0′/S1′ ledger),
`doc/view-change-design.en.md` (round election),
`doc/migration-runbook-no-econs.en.md` (the v2.0.3 non-consensus migration — the *code
upgrade* half of the flag day),
`doc/public-testnet.md` (multi-operator rehearsal),
`docker/testnet/README-drills.md` (G1–G12 drill matrix).
**Language:** English (project convention for `doc/`).

---

## 0. TL;DR

This is the **consensus** flag day on top of the earlier non-consensus migration. It enables
the **Layer S** hardening at block **13,325,000** and the **Layer H** rotation change at block
**13,400,000**, using `config.history` (already in the tree). The chain is **halted at block
13,320,067**, so the cutover is the cheapest possible: there is no mixed-version window —
the resume block itself is produced by the new code.

Three non-negotiables:

1. **One artifact, one tag.** Every node on the *same* frozen commit; `curl /version`
   identical on every node before the resume.
2. **Freeze the fork heights *before* publishing.** `config.history` entries are immutable
   once passed; `13,325,000` must still be in the future when the release ships.
3. **Halt, don't fork.** Layer H is a real hard fork (old nodes cannot validate it): run the
   readiness gates (§5) and coordinate a single flag-day window, or postpone `H_strict`.

---

## 1. What this upgrade contains

| Area | Change | Layer / site | Consensus-visible? |
|---|---|---|---|
| Skip attestation | `Block.skips[]` written + warn-mode validation | S — `chain.js` | additive field (hashed identically by old nodes) |
| Adaptive quorum | deterministic `eligible(h)`, one `blockQuorum()` helper | S — `consensus.js`, `consensusQuorum.js` | local policy (no block rule) |
| Absence accounting | streaks, **soft jail** (no slashing), `leaderHealth.js` | S — `leaderHealth.js` | derived state |
| Rotation replacement | top-`L` minus jailed + **standby promotion** | H — `chain.js` `activeLeaderSet`/`standbyLeaderSet` | **yes — hard fork** |
| Determinism fixes | canonical leader order (F6), epoch-schedule persistence (F7), one-proposer-per-round, halt stagger | S — `chain.js` `generateLeaders`/`minerWorker` | schedule-affecting |
| Halt recovery | deterministic force-finalize rank + `FF_FETCH`/`FF_BLOCK`, monotone votes, `haltBreaker` recovery round | S — `consensus.js`, `p2p.js` | local policy (env `HALT_BREAKER=0` off-switch) |
| Observability | `/consensus`, `/debug/statehash`, `/metrics`, `/events`, additive `/schedule` `/leader` `/allminers` `/block`; `scripts/avalon-watch.js` | S — `src/http/*` | none |
| Vote ledger (shadow) | `QC_SHADOW` observer; `h` + `justify` on the wire | S0′ — `consensus.js`, `voteState.js` | none while shadow |

**Single-vote enforcement is ON by default** (`config.singleVote: true`, chain config —
no env). The view-change round election ships with this release: PRECOMMIT is round-aware
(a higher-round backup is a legitimate handover) and COMMIT follows the node's own
precommit lock, preferring the highest round with a precommit QC. `qcEnforce` stays OFF.
This is a consensus-affecting default: every node must run the same build before the cutover
and the G1–G11 drills must be green with the gate ON. Force-finalize fallback stays OFF
(`forceFinalizeFallback: false`) — no halt recovery by bypassing quorum. Also out: economy
fork `#13330000` (already excluded — see the migration runbook).

---

## 2. Network state at cutover (measured)

| Datum | Value | Source |
|---|---|---|
| Head | **13,320,067** (halted since 2026-06-27) | `GET https://dtube.fso.ovh/count` |
| Layer S (`H_S`) | **13,325,000** (~4 h after the resume at 3 s) | `src/config.js` history |
| Layer H (`H_strict = H_standby`) | **13,400,000** (~3 days after the resume) | `src/config.js` history |
| Effective rotation change | first epoch boundary ≥ `H_standby` = `ceil(13,400,000 / 5)·5` | `chain.js` |
| Economy fork `13,330,000` | **never activates** (excluded in code) | migration runbook |

Re-measure `head`, the head block hash and the two heights immediately before the window and
record them on the cutover sheet.

---

## 3. Activation schedule

`config.read(blockNum)` applies `history` entries cumulatively in numeric order. The relevant
entries (values already in the tree — do **not** edit without re-review):

```js
13325000: {                       // Layer S — ~4 h after the resume
    forceFinalize: true, consensusSigVersion: 2,
    skipRecording: true, skipStrict: false,   // warn mode
    quorumMin: 3, quorumEligibility: 'lastTurn',
    jailMissThreshold: 30, jailBlocks: 200, jailBackoffMax: 4,
    haltBreaker: true, haltBreakerMs: 21000,
    leaderStandbys: 5
},
13400000: {                       // Layer H — the real flag day
    skipStrict: true, standbyEnabled: true, canonicalLeaderOrder: true
}
```

* **Before `13,325,000`** the node behaves as today (plus the always-on F2/F6/F7/one-proposer
  fixes, which are safe and not height-gated).
* **`13,325,000`–`13,399,999`**: `skips[]` recorded, warn-only validation, jail active,
  halt-breaker armed, standbys present in the ladder. Old nodes keep validating — this window
  is the canary.
* **`13,400,000`+** (effective at the first epoch boundary): strict `skips` validation +
  standby promotion + canonical order. **Old nodes can no longer validate** — every leader and
  every public validator must be upgraded before this height.

---

## 4. Release/tag preparation (coordinator, before the window)

```bash
# 1. Freeze the reviewed tip as an immutable tag (do NOT reuse an existing tag)
git checkout <reviewed-commit>
git tag -a v2.1.1 -m "Layer S/H consensus release (H_S=13325000, H_strict=13400000)"
git push origin v2.1.1

# 1b. The release MUST carry its own version: the census reads /version and
#     NODE_STATUS (src/p2p.js → package.json), so package.json.version must match
#     the tag. A hardcoded/stale version made two releases indistinguishable.
node -e 'const v=require("./package.json").version; console.log("package.json version:",v)'
# expected: the tag without the leading v (e.g. 2.1.1)

# 2. Confirm the heights are still in the future and the economy fork is absent
node -e 'global.logr=new Proxy({},{get:()=>()=>{}});global.cache={state:{}};
const c=require("./src/config.js");
const s=c.read(13325000), h=c.read(13400000), e=c.read(13330000);
console.log("S:",s.skipRecording,s.skipStrict,s.haltBreaker,"| H:",h.skipStrict,h.standbyEnabled,
"| econs:",e.rewardPoolYearlyRate||"absent")'
# expected: S: true false true | H: true true | econs: absent

# 3. Quality gates on the tagged tree (same as CI)
npm ci
npm run lint
npm test                              # 23 assert-only suites, all green
node test/run.js schedule-determinism consensus-invariants block-rank schedule-persist leader-health skip-attestation
```

Publish on the single coordination channel: the tag, the exact `git describe --tags`, the
heights, the peer list and the window.

---

## 5. Readiness gates — hard, not aspirational 🔴

Do **not** enable `H_strict`/`H_standby` unless **all** of these hold (plan §8.2). If any
fails, postpone by re-pointing the heights **before** the release ships (they are immutable
once passed).

| # | Gate | How to measure | Pass condition |
|---|---|---|---|
| G-1 | **Version census** | `scripts/upgrade-preflight.js` (below), or `curl -s localhost:3001/version` on every node; `NODE_STATUS`/`/peers` carry it too | 5/5 current leaders + 100% of known public validators on the frozen tag. A leader already jailed/absent is excluded (it cannot produce). |
| G-2 | **Schedule agreement** | `scripts/upgrade-preflight.js` (below), or compare `/debug/statehash` and `/schedule` across all upgraded nodes | identical for ≥ **1,000 consecutive blocks** (catches F6/F7) |
| G-3 | **Warn-mode clean** | `grep "skips mismatch" <log>` | **zero** for ≥ 1,000 blocks with `skipStrict: false` |
| G-4 | **Drill matrix** | `bash docker/testnet/drills/run-all-drills.sh --long` on the **exact release artifact** | G1–G12 **green**, including G11 (halt breaker) |
| G-5 | **Rollback artifact** | per node, before `H` | pre-`H` DB snapshot + `blocks.bson` copy stored and verified |

`G-2`/`G-3` are the ones that matter: a mismatch there means two nodes disagree on the ladder,
and `H_strict` would turn that into a rejected block instead of a warning.

**G-1/G-2 automated** — `scripts/upgrade-preflight.js` (read-only, no DB) runs the online gates
and exits non-zero on any failure:

```bash
AVALON_URLS='http://leader1:3001,http://leader2:3001,...' \
  node scripts/upgrade-preflight.js --minutes 20 --min-aligned 5
# G-1 version census (all nodes must report the frozen tag)
# G-2 schedule agreement (aligned /debug/statehash, 0 mismatches)
```

Run it for the whole observation window (≥ 1,000 blocks ≈ 50 min at 3 s); `--json` gives
machine-readable output for the checkpoint log. G-3 (logs) and G-5 (backups) stay per-node.

---

## 6. Flag-day sequence 🔴

The chain is halted, so the resume **is** the cutover. Non-negotiable order: **stop all →
verify → start all on one version**.

```bash
# --- Per node, before the window (S0) ---
cd /path/avalon && git rev-parse HEAD && git status --short
cp -a .env /backup/env.$(date +%F)                     # holds node keys
cp -a scripts/start.sh /backup/start.sh.$(date +%F)
cp -a "$BLOCKS_DIR"/blocks.bson /backup/blocks.bson.$(date +%F)
cp -a "$BLOCKS_DIR"/*.idx /backup/ 2>/dev/null
mongodump --db "${DB_NAME:-avalon}" --out /backup/mongo-$(date +%F)
mkdir -p state                                          # vote_state.json + schedule.json live here

# --- Cutover (window, all operators, chat open) ---
# 1. Stop every node (no node may remain on the old code for the resume)
# 2. Checkout the frozen tag, install, verify
git fetch --all --tags && git checkout v2.1.1
npm ci
git describe --tags              # must equal the coordinator's tag
npm test                         # green
# 3. Environment (see §7) then start
./scripts/start.sh               # or systemd/pm2/screen

# 4. Resume: with the chain halted, the first block is produced by the new code.
#    Kick production only if needed (the halt-breaker/schedule handles it):
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3001/mineBlock
```

Do **not** truncate anything as part of this upgrade: the halt is the cutover, not a corruption.
`scripts/auto_resolve_halt.sh` is last-resort only (and now refuses repeated truncation).

---

## 7. Environment variables for this release

In addition to the v2.0.3 set (`CORS_ORIGIN`, `HTTP_HOST`, `TRUST_PROXY`, `ADMIN_TOKEN`,
`LOG_ADMIN_TOKEN` — see the migration runbook §S3), the Layer S/H release adds these. Only
`HALT_BREAKER` changes node behaviour; the rest are paths/opt-ins. (The S1′ gates
`singleVote`/`qcEnforce` are **chain config**, not env — see the row below.)

| Variable | Default | Ship value | Meaning |
|---|---|---|---|
| `HALT_BREAKER` | on (when `config.haltBreaker`) | leave unset | `0` disables the recovery round per node (liveness only; see §9) |
| `CONSENSUS_SINGLE_VOTE` | **off** | **deprecated — do not set** | S1′ single-vote is **chain config** (`config.singleVote`), **not** an env var: a per-node switch would let one node refuse its own votes and diverge. It is now **ON by default** (`true` in `config.history[0]`) — verify `/consensus` reports `singleVote: true` on every node. Same rule for `QC_ENFORCE` → `config.qcEnforce` (still off). |
| `QC_SHADOW` | off | `1` recommended | enables the read-only vote-ledger observer (logs `QC-*`, refuses nothing) |
| `VOTE_STATE_PATH` | `./state/vote_state.json` | leave default | crash-safe vote record (local file, never chain data) |
| `SCHEDULE_PERSIST_PATH` | `./state/schedule.json` | leave default | persisted epoch schedule (fixes F7 restart divergence) |
| `AUTO_ROLLBACK` | **off (`0`)** | leave unset | opt-in only: set to `1` to enable proof-gated automatic rollback on `CHAIN DIVERGENCE` |
| `MAX_REORG_DEPTH` | *(env removed)* | do not set | **Chain config** (`config.maxReorgDepth`, default `10` at genesis). Reorg depth is consensus-relevant fork-choice data: a per-node env var would let two nodes make different rollback decisions on the same fork. |
| `STATE_SNAPSHOT_INTERVAL` | `10000` | leave default | block interval for the derived-state snapshots used to restore on rollback; `0` disables new snapshots (rollback then fails closed) |
| `STATE_SNAPSHOT_KEEP` | `3` | leave default | number of recent state snapshots retained |
| `LEADER_STATS` | off | `1` optional | per-leader produced/missed/jail counters |

`QC_SHADOW=1` is the intended posture during the S→H observation window: it certifies the
quorum on every block without being able to refuse one.

---

## 8. Post-cutover verification (checklist)

```bash
curl -s localhost:3001/count                     # head ADVANCING past 13,320,067
curl -s localhost:3001/version                   # {"version":"2.1.1"} — IDENTICAL on every node
curl -s localhost:3001/block/$((H+1)) | grep -o '"phash":"[^"]*"'   # = hash of H
curl -s localhost:3001/schedule | jq             # epoch/set/standbys/jailed present
curl -s localhost:3001/consensus | jq            # eligible, quorum, jail[], lastSkips[]
curl -s localhost:3001/metrics | grep avalon_flag
grep -c "Hard Fork #13330000" /var/log/avalon.log      # expected: 0 (forever)
grep "Hard Fork #" /var/log/avalon.log | tail -3       # 241600, then 13325000 at the height
grep -c "Different chain id, disconnecting" /var/log/avalon.log   # expected: 0
```

Determinism check (the reason the testnet exists): on a control node, rebuild from genesis on
the same tag and confirm the **same head and the same block hashes** as a running node.

```bash
REBUILD_STATE=1 ./scripts/start.sh
# cross-node: curl -s localhost:3001/debug/statehash | jq -r .stateHash
```

Then watch until `13,400,000`: `/count` monotonic, no growing `possBlocks`, no `QC-DIVERGENCE`
(unsafe direction), normal jail transitions.

---

## 9. Emergency: halt without a fork

The recommended posture is **halt rather than fork** (`forceFinalizeFallback: false`). If the
chain stalls:

1. **Collect** logs (`/logs`, `grep "Hard Fork\|halt\|force"`), `/consensus`, `/debug/statehash`
   on every node. Do **not** restart divergent nodes individually.
2. **Halt breaker**: if the freeze is a same-round double death, the breaker runs a recovery
   round after `haltBreakerMs` (21 s) and finalises with the unanimity of the remaining eligible
   set — no operator action. If you need to suppress it, set `HALT_BREAKER=0` on all nodes
   (the conservative G12 behaviour: deterministic halt, restarting one node resumes).
3. **Soft jail**: a leader jailed by 30 consecutive on-chain misses is only *demoted*; it is
   reinstated automatically after `jailBlocks` (200) or immediately via a heartbeat (no fee,
   existing tx type 18):
   ```bash
   node scripts/heartbeat.js -M <leader> -F <leader_key.json> -A http://localhost:3001 --wait
   ```
   Then verify `/consensus` shows `jailed: false` and the node reappears in `/schedule`.
4. **Last resort**: `DRY_RUN=1 ./scripts/auto_resolve_halt.sh` (it now refuses repeated
   truncation), then coordinate a manual intervention. Keep the S0 backups.

---

## 10. Rollback

| Situation | Action | Data loss |
|---|---|---|
| **Layer S** misbehaves (before `H_strict`) | redeploy the previous tag; the chain is unchanged (no new validity rule; old code ignores `skips`) | none |
| **Layer H must be undone after activation** | coordinated stop → restore the pre-`H` DB + `blocks.bson` snapshot on every node → redeploy the old tag | blocks produced after `H` (bounded by the snapshot age) |
| Split detected | **do not truncate automatically**; halt, collect, coordinate | — |

The two decision items that are **irreversible once the height is passed** — `skipStrict` and
the standby heights — must be settled before the artifact is published (§4/§5). Rollback after
`H` is an operational failure, not an expected path.

---

## 11. Operator checklist

**Coordinator — before announcing**
- [ ] Reviewed tip frozen as an immutable tag and pushed; `git describe --tags` published.
- [ ] Heights re-measured; `read(13325000)`/`read(13400000)`/`read(13330000)` verified (§4.2).
- [ ] Drill matrix G1–G12 green on the **exact** tag; G11 (halt breaker) explicitly re-run.
- [ ] Peer list + bootstrap endpoint ready; window + checkpoints decided.
- [ ] Master/leader private keys stored safely (testnet keys only on the testnet).

**Each operator — before the window**
- [ ] Node.js ≥ 24, MongoDB running, **NTP/chrony active** (`maxDrift` = 200 ms).
- [ ] P2P port reachable from the internet; HTTP port per policy.
- [ ] `git checkout <tag>` + `npm ci`; `git describe --tags` matches the coordinator's.
- [ ] `state/` directory exists and is writable (vote_state.json + schedule.json).
- [ ] `HALT_BREAKER` unset, `QC_SHADOW=1`; no S1′ env set. `GET /consensus` shows `singleVote: true`, `qcEnforce: false` on every node.
- [ ] Backups taken: `blocks.bson` + index, Mongo dump, `.env`, previous commit.

**Launch day — checkpoints**
- [ ] `curl /version` identical on every node (census, G-1).
- [ ] `/count` monotonic past `13,320,067`; `/peers` shows independent entities.
- [ ] `grep -c "Different chain id, disconnecting"` = 0.
- [ ] `grep -c "Hard Fork #13330000"` = 0.
- [ ] Every operator posts `version`/`count`/`peers` on the channel.

**Observation window (until `13,400,000`)**
- [ ] `/debug/statehash` + `/schedule` identical across nodes for ≥ 1,000 blocks (G-2).
- [ ] Zero `skips mismatch` warnings (G-3).
- [ ] Zero `QC-DIVERGENCE` (unsafe direction) with `QC_SHADOW=1`.
- [ ] Alerts wired from `/metrics` + `/events` (halt, isolation, quorum degraded, jailed leader,
  halt-breaker fired, divergence).

---

## 11.1 Automatic rollback on `CHAIN DIVERGENCE` (v2.2)

Automatic rollback is **disabled by default** (`AUTO_ROLLBACK=0`). A node that detects a
fetched block at/below its head must first verify that its local block at that height exists
**and has a different hash**: block application is serialized, so an identical block arriving
from a second peer is a normal duplicate and is ignored without any divergence event or
rollback. Only a genuinely conflicting block (or a head+1 block with the wrong parent hash)
is considered. With `AUTO_ROLLBACK=1`, the node compares its own head vote proof with the
proofs advertised by peers in `NODE_STATUS.headVoteProof`. A rollback happens **only** when:

- the competing block is backed by a verifiable quorum of signed **COMMIT** votes
  (`t:6, d.r === COMMIT`, finality phase), not PRECOMMITs. PRECOMMIT is a round-0 poll;
  two different blocks at the same height can gather precommit quorums across rounds, so
  a PRECOMMIT proof is not finality evidence;
- the proof is verified against the eligible leader set and `blockQuorum()` of the
  **proof's own height** (the contested block height), read from chain config at that
  height — never against the local head's adaptive eligibility;
- the local node has no valid COMMIT finality proof of its own head. A locally finalized
  block is never replaced by a peer proof, regardless of the peer's claimed height;
- the competing chain shares a common ancestor with the local store within the
  chain-configured `config.maxReorgDepth` (default `10`); and
- the ancestor is at or above the **local finality floor**: the last block this node
  finalized itself with a valid COMMIT quorum. On restart the floor falls back to the
  current head, which is conservative.

Otherwise the node fails closed: it keeps its chain, logs `CHAIN DIVERGENCE`, and emits
`chain-divergence`.

**Block-application flush safety (v2.3+):** `chain.addBlock()` only advances the in-memory
head (`recentBlocks`), miner worker and output after a successful MongoDB state flush. If the
flush fails, the schedule change is rolled back, the in-memory head is not advanced, and the
error is surfaced to the caller so the process can reconcile on restart instead of mining on
a non-persisted head.

When it does fire, the sequence is:

1. `chain-rollback-start` event + warning log with ancestor/target heights and signers, after a
   preflight that refuses to proceed when no snapshot at/below the ancestor exists;
2. mining paused, BSON block index/file truncated (index first), or Mongo `blocks` tail deleted;
3. derived Mongo state restored from the newest snapshot at/below the ancestor into a **fresh
   temporary database** (`<db_name>_rebuild_tmp`), never by dropping the active database; RAM
   state (cache, DAOs, vote ledger, schedule, anti-replay `recentTxs`, tx-history queue,
   jail/stats indexes, pending consensus votes) is cleared;
4. deterministic replay **only** from `snapshot+1` to the ancestor over the retained canonical
   blocks runs against the temp database — balances, nonces, leader schedule, jail state and the
   `txs` index are re-derived without touching genesis or the discarded tail. With no usable
   snapshot the rollback fails closed instead of falling back to a full rebuild;
5. on replay success, derived collections are swapped from the temp database into the original
   database, the temp database is dropped, and `chain-rollback` is emitted before forward
   `recover()` resumes.

**Failure behavior:** if any rollback step fails (snapshot restore, replay, or swap), the temp
database is discarded and the original database remains active. The rollback fails closed with a
`recover-giveup` (`rollback:true`) event; the operator must investigate before resuming. This
avoids leaving the node with an empty active database after a failed rebuild.

**Transactions from the orphaned tail:** their effects on accounts/contracts are gone (their
state was never restored from the snapshot). Their hashes are also removed from `recentTxs`,
so a resubmission is accepted again. Before truncating, the node saves those txs and re-offers
them to the mempool *after* the replay, but only if they are still valid under the canonical
state; if the majority chain already contains them, normal sync removes them from the pool
again. No half-applied transaction survives.

Observe it with `curl -s localhost:3001/events | jq`. A clean drill shows
`chain-divergence → chain-rollback-start → chain-rollback → recover-start`. A
`recover-giveup` event with `rollback:true` means the rollback failed closed; the temp rebuild
database is discarded and the original derived database remains active, but the operator must
investigate (the block store may already have been truncated to the ancestor). Unit/integration proof:
`node test/divergence-rollback.js`, `node test/state-snapshot.js` and
`node test/p2p-rollback-integration.js`.

### 11.2 Confirmation depth (exchanges / bridges)

Avalon does not emit BFT finality for blocks applied by recovery replay: a node that
restarts or catches up may append blocks without having produced a local COMMIT quorum.
`config.maxReorgDepth` (default `10`, chain config) bounds the *proof-gated* automatic
rollback walker, but it is **not** a finality guarantee by itself.

External systems that credit deposits, mint wrapped assets, or release bridge funds
**MUST** wait for a confirmation depth derived from that bound:

- **Minimum confirmation depth:** `2 * config.maxReorgDepth` blocks (default `20`).
- **Recommended for exchanges/bridges:** wait for the higher of `2 * config.maxReorgDepth`
  blocks and the normal deposit-confirmation SLA used for this asset, and confirm the
  block hash is on the same canonical head seen by at least two independent Avalon nodes.
- **Never credit on a proofless reorg target:** only blocks at or below the local finality
  floor (`consensus.localFinality()`) have been finalized by this node with a COMMIT quorum.
  Recovery-appended blocks above that floor may still be reorganizable until this node
  finalizes them.

Treat `maxReorgDepth` as a chain-wide safety parameter. Raising it increases the maximum
proof-gated rollback window and therefore increases the required confirmation depth.

---

## 12. Definition of done

- [ ] Same tag on every node; `/version` identical everywhere.
- [ ] Layer S active at `13,325,000` (`Hard Fork #13325000` in the logs once).
- [ ] G-1…G-5 gates passed before `13,400,000`.
- [ ] Layer H active at the first epoch boundary ≥ `13,400,000`; every node upgraded.
- [ ] `grep -c "Hard Fork #13330000"` = 0; no divergence in the observation window.
- [ ] Alerts and the Discord watcher (`scripts/avalon-watch.js`) running per node.
- [ ] Rollback artifacts (S0 backups) stored and verified.

---

## 13. Appendix — quick commands

```bash
# What is a node doing?
curl -s localhost:3001/version
curl -s localhost:3001/consensus | jq '{head, eligible, quorum, jail: [.jail[]?]}'
curl -s localhost:3001/schedule | jq '{epoch, set, standbys, jailed}'
curl -s localhost:3001/debug/statehash | jq -r .stateHash
curl -s localhost:3001/metrics | grep -E 'avalon_(height|peers|eligible_leaders|quorum_threshold|poss_blocks)'

# Which flags are in force?
curl -s localhost:3001/metrics | grep avalon_flag

# Flag-day gates G-1 (version census) + G-2 (schedule agreement)
node scripts/upgrade-preflight.js --nodes http://leader1:3001,http://leader2:3001 --minutes 20
node scripts/upgrade-preflight.js --json | jq .   # machine-readable

# Peer versions (the same value NODE_STATUS carries)
curl -s localhost:3001/peers | jq -r '.[].node_status.version' | sort | uniq -c

# Heartbeat a soft-jailed leader
node scripts/heartbeat.js -M <leader> -F <key.json> -A http://localhost:3001 --wait

# Watch a node and page a Discord webhook on halt/isolation/divergence
DISCORD_WEBHOOK_URL='…' NODE_NAME=<name> AVALON_URL=http://localhost:3001 \
AVALON_WATCH_URLS='http://peer2:3001,http://peer3:3001' node scripts/avalon-watch.js
```
