# Consensus Hardening — One Quorum Function + Vote Ledger (design draft)

**Status:** draft for review — no behaviour change shipped
**Complements:** `doc/consensus-offline-leaders-plan.en.md` (Layer S / Layer H)
**Touches:** `src/consensus.js`, `src/consensusQuorum.js` (new), `src/p2p.js`, `test/quorum-lock.js` (new)
**Non-goals:** ABCI, block format, key format, transaction types, rewards, new rounds/views,
replacement of the DPoS leader election. This is ~150 lines of rules, not a re-platform.

---

## 0. Why this and not CometBFT

The chain halted at **13,320,067** with 2 of 5 leaders down. That is not a defect of the
bespoke protocol; it is the liveness bound of any BFT protocol. CometBFT with the same 5
validators needs >2/3 of voting power to commit: 2/5 offline = 40% > 1/3 = **no commit,
forever**. A library would not have un-halted this chain.

What *is* defective is narrower and worth fixing on its own terms:

1. two different quorum formulas in the same file;
2. a vote is gossip, not evidence — nobody can *prove* a quorum to anybody else;
3. nothing forbids a node from voting for two competing blocks at the same height;
4. the eligible set (and therefore the quorum denominator) is derived from each node's
   local view, so two nodes can compute different quorums for the same height.

Points 3 and 4 are the fork vectors. They are cheaper to fix than to re-platform, and the
fix is what makes the protocol *auditable*: after it, safety is one invariant plus one
inequality, which fits on a page and can be property-tested.

---

## 1. What the code does today (verified)

### 1.1 Two quorum formulas

| Site | Formula | n=3 | n=4 | n=5 | n=6 | n=10 |
|---|---|---|---|---|---|---|
| `consensus.js:79` (`tryNextStep`, normal path) | `floor(2n/3)+1` | 3 | 3 | 4 | 5 | 7 |
| `consensus.js:413` (`_getQuorumThreshold`, force-finalize) | `min(ceil(leaders·2/3), max(ceil(2n/3), 3))` with `leaders=5` | 3 | 3 | 4 | **4** | **4** |

They agree at n = 3, 4, 5 — which is exactly why the divergence has never been seen. It
becomes live the moment the eligible set can exceed `config.leaders`, i.e. **the moment
Layer H (standby promotion) lands**. At n = 6 the old formula returns 4/6 = exactly 2/3,
a quorum that does not strictly intersect itself. `test/quorum-lock.js` asserts both the
current equivalence and the divergence.

### 1.2 Votes cannot be verified as a quorum

`endRound` (`consensus.js:274`) broadcasts `{t:6, d:{r, b:{hash}, ts}}`. Receivers count
`message.s.n` into `possBlock[r]` (`remoteRoundConfirm`, L290) and never receive the other
signers' signatures. Consequences:

* a node cannot prove to a peer that a quorum exists — it can only ever count what it saw;
* observers must be *stricter* (+1, L85) to compensate, so a leader and an observer
  finalise the same height at different thresholds. Not a fork, but a liveness tax and one
  more place where two nodes disagree about "finalised";
* `queue` (`consensus.js:239`) replays raw messages, so recovery cannot distinguish
  "I saw a quorum" from "I saw one signer".

### 1.3 No single-vote rule

`round(0, block)` pushes `NODE_OWNER` into the round list of *every* candidate hash it
validates (L233-236), and `possBlocks` holds competing hashes simultaneously. A node that
sees two colliding blocks at height `h` pre-commits **both**. With n = 4 and q = 3, two
disjoint 3-voter sets can then each reach q for different hashes. The same holds for
commit votes (L267-272). Force-finalize (`t:7`) is a **second, independent voting channel**
that bypasses this entirely.

`test/quorum-lock.js` reproduces this as a failing-then-passing pair: with
`singleVote: false` both halves reach a QC; with `singleVote: true` the second is refused
and the equivocations are recorded.

### 1.4 The denominator is a local view

`activeLeaders()` (`consensus.js:47`) walks `chain.recentBlocks` — this node's own recent
history — and filters by the current shuffle. Two nodes with 1-block different views
compute different `n`, hence different `q`, for the same height. `_getQuorumThreshold`
adds a second local input (`config.leaders`). Any "2/3" that depends on a local view is not
a quorum, it is a hope.

---

## 2. The change

### 2.1 One function

`src/consensusQuorum.js`:

```js
function quorumSize(n) {                    // smallest integer strictly above 2n/3
    if (!Number.isInteger(n) || n <= 0) return Infinity   // fail closed
    return Math.floor((2 * n) / 3) + 1
}
```

Every call site — normal rounds, observer, force-finalize, jail-aware adaptive quorum —
calls this one function with a chain-derived `n`. `_getQuorumThreshold` is deleted.
`legacyForceFinalizeQuorum()` stays in the module **only** as the test oracle.

### 2.2 Canonical eligible set per height

`eligible(h)` must be a pure function of block data, identical on every node:

```
eligible(h) = sort( unique(
      members(schedule_epoch(h))
    ∪ producers(blocks[h-2L .. h-1])
    ) minus jailed(h) )
```

* `schedule_epoch(h)` must be the schedule the chain says was in force at `h`, not the one
  recomputed at restart (failure **F7** in the plan).
* `jailed(h)` comes from attested `skips[]`, not from local timeouts (plan Layer S, **F1/F2**).
* sorting by name kills **F6** (`node_appr` ties are currently Mongo natural order).

Until Layer S lands, `eligible(h)` falls back to today's `activeLeaders()` **sorted**, so
the module can be adopted before the skip attestation exists.

### 2.3 The invariant that carries safety

> **INV-1 (single vote).** For any node and any `(h, r)`, the node emits at most one vote
> hash.

> **THEOREM.** With INV-1, a chain-derived `eligible(h)` identical on all nodes, and
> `q = floor(2n/3)+1`, two different hashes cannot both reach a commit QC at the same
> height.
>
> *Proof.* If `A` and `B` both have commit QCs, pick signer sets `S_A, S_B ⊆ eligible`,
> `|S_A|, |S_B| ≥ q`. Since `q > 2n/3`, `|S_A| + |S_B| > 4n/3 > n`, so
> `S_A ∩ S_B ≠ ∅`. A signer in the intersection voted for `A` and for `B` at the same
> `(h, 1)`, contradicting INV-1. ∎

Note what is *not* needed: no views, no round numbers, no leader rotation change, no
unlock rule, no slashing. Avalon's two phases are phases, not views, so Tendermint's
lock/unlock machinery reduces here to INV-1 plus a local lock (2.4) that is a **liveness**
aid, not a safety requirement.

### 2.4 Local lock (convergence aid)

```
locks[h] = hash        # set on our own PRECOMMIT at h
canPrecommit(h, X) = locks[h] === undefined || locks[h] === X
```

Rationale: without it, a node that precommitted `A` happily precommits `B` when `B`
arrives late, burning its own vote on a block that cannot win and delaying the round.
The lock is **not** released by an unlock certificate, because there is no view change to
justify one: the node simply stops voting on that height until one candidate reaches a
commit QC, and then adopts the committed hash — which INV-1 already guarantees is unique.
Commit votes are unaffected (a node must always be able to finalise what it precommitted).

### 2.5 Votes become evidence (QC on the wire)

Minimal payload change, additive:

```js
{ t: 6, d: { r, b: { hash }, ts, h, justify: [{ n, s }, ...] } }
```

* `h` — height, explicit. Today it is inferred from `b` (which is only a hash for non-self
  votes), which is why `remoteRoundConfirm` has to scan `possBlocks` to find the height.
* `justify` — the signatures the sender used to enter phase `r`: for `r = 1` this is the
  round-0 QC. Verified with the **same** `consensus.verifySignature`, so no new crypto.
* Receivers re-verify each signature against `eligible(h)` and count distinct signers.

**Why this is wire- and signature-compatible.** `verifySignature` (L644) serialises the
object it *received*, minus `s` (sorted keys under `consensusSigVersion: 2`). An old node
therefore hashes and verifies the new fields identically and simply ignores them — the same
argument the plan makes for `blocks.skips[]`. No flag day is required to *send* `h` and
`justify`.

Once QCs exist, the observer `+1` (L85) is deleted: an observer accepts at `q` like
everyone else, because it no longer needs to be inside the signer set to know that a
quorum exists. This removes the leader/observer threshold split.

Two implementation traps:

* **Freshness applies to the envelope only.** `p2p.js:397-400` rejects a `BLOCK_CONF_ROUND`
  whose `d.ts` is outside `±2·blockTime` (6 s). `justify` entries are round-0 signatures
  produced *before* the round-1 vote, so they must be verified for signature, height,
  phase, hash and eligible membership — **not** for freshness, or every commit vote is
  dropped as stale.
* **Payload growth is bounded and small.** `justify` carries at most `q ≤ 5` bs58
  signatures (~100 B each) and only on round-1 votes: ≈0.5 kB per leader per block,
  ≈1 kB/s network-wide at 3 s blocks. Nothing touches block size, `maxTxPerBlock`, the
  REST API, the indexers or the wallets.

### 2.7 Restart safety (mandatory before S1′ enforces INV-1)

INV-1 lives in RAM. A node restarted mid-height loses `votes` and `locks` and could
therefore vote twice at the same `(h, r)` — the exact hole INV-1 exists to close. The
standard fix is the one CometBFT uses (`priv_validator_state.json`): persist the minimal
voting record before broadcasting, and refuse to start if it cannot be written.

```
state/vote_state.json = { height: h, round: r, hash: X, ts: 1601477849000 }
```

Written atomically (temp file + `rename`) **before** `p2p.broadcast()` in `endRound`, read
at boot. A few hundred bytes, one file, no DB schema change, no migration. It is a local
file, not chain data: it never enters a block, the block hash, or the state hash.

Without 2.7, S1′ would *narrow* the equivocation window instead of closing it, which is
worse than not shipping it: it would look safe.

### 2.8 What this draft adds to blocks: nothing

| Layer | Before | After | Compatibility |
|---|---|---|---|
| **Block** (`Block(index, phash, timestamp, txs, miner, missedBy, dist, burn, signature, hash)`) | 10 fields | **identical** | no new field, no hash change, no flag day, no indexer/API/wallet change |
| **Consensus messages** `t:6` / `t:7` | `{r, b, ts}` | `+{h, justify}` | additive; old nodes hash/verify the received object unchanged and ignore the fields |
| **Local state** | — | RAM ledger + `state/vote_state.json` | local file, never hashed, never in a block |
| **DB / Mongo** | — | unchanged | no schema change, no migration, no disk growth |

For contrast, the two designs that *do* touch blocks, and why this draft avoids them:

* **`skips[]`** — one optional additive field, needed by step **H** for a chain-derived
  `eligible(h)` (plan Layer S, `missedBy` is its unvalidated ancestor). Hashed identically
  by old nodes because `blockHashSerialization: 2` hashes the received object minus
  `hash`/`signature` (`chain.js:822-833`). Not needed by S0′/S1′.
* **A QC in the block header** — would give light clients verifiable finality, and would be
  a hard fork with `blockHashSerialization: 3`. Deliberately out of scope: the QC stays
  volatile, so `recover()` remains forward-only and no external tooling changes.

### 2.6 Force-finalize joins the same ledger

`t:7` votes are `(h, r = FF, hash)` votes in the **same** ledger:

* FF may not select a hash the node precommitted against at that height (`canPrecommit`);
* FF counts with `quorumSize(eligible(h).length)` — never its own formula;
* the local candidate ranking stays (earliest `ts`, then lowest hash, already total and
  deterministic), but a node only *applies* the ranked winner if either (a) it has a QC on
  it, or (b) `forceFinalizeFallback` is on *and* the ledger shows no conflicting vote at
  that height.

FF remains the crash net. It stops being a parallel universe with its own rules.

---

## 3. Patch map

| File | Site | Change |
|---|---|---|
| `src/consensus.js` | L5-7, L76-86 | delete `consensus_need/total/threshold` and the local `threshold` computation → `consensusQuorum.quorumSize(eligible(h).length)` |
| `src/consensus.js` | L47-67 `activeLeaders` | return a **sorted**, chain-derived array; keep the old body behind `ELIGIBLE_FALLBACK=1` for the S0 rehearsal |
| `src/consensus.js` | L79 | remove the observer `+1` (only when `QC_MODE=1`) |
| `src/consensus.js` | L110-165 `tryNextStep` | consult `qcHash(ledger, h, r, eligible)` instead of `possBlock[r].length` |
| `src/consensus.js` | L226 | `possBlocks` capacity from `eligible.length`, not `activeLeaders().length * 2` |
| `src/consensus.js` | L233-236, L267-272 | route every self-vote through `recordVote`; drop the vote if `!accepted` |
| `src/consensus.js` | L274-289 `endRound` | add `h` + `justify`, sign `{n, s}` entries of the QC |
| `src/consensus.js` | L290-311 `remoteRoundConfirm` | validate `justify` (signature + eligible membership + distinct signers + quorum) before `tryNextStep` |
| `src/consensus.js` | L413-419 | **delete** `_getQuorumThreshold` |
| `src/consensus.js` | L489-599 `_resolveForceFinalize` | count via `hasQC`; add the `canPrecommit` guard |
| `src/p2p.js` | L392-443 | `ts` window check stays; pass `message.d.h` down so the queue is keyed by height |
| `src/p2p.js` | L61, L363 | `blockSenders` keyed by `height:hash` (two colliding blocks at one height currently overwrite each other) |
| `src/consensus.js` | L274-289 `endRound` | write `state/vote_state.json` (atomic) **before** `broadcast`; refuse to start if unwritable |

The module itself touches nothing: it is pure and is not `require`d by any running code
until step S1.

---

## 4. Rollout

| Step | Content | Enforcement | Risk |
|---|---|---|---|
| **S0′** `v2.1.x` | ledger in shadow mode: `recordVote` on every self-vote and every received vote, `qcHash` logged next to `possBlock[r].length`, mismatches logged as `QC-DIVERGENCE`. Sends `h` + `justify`. | none | none — nothing is refused |
| **S1′** `v2.1.y` | `QC_MODE=1`: INV-1 enforced, unified quorum, observer `+1` removed, FF on the ledger | local policy | a node that refuses its own duplicate vote can only finalise *fewer* bad things |
| **H** `v2.2.0` | `eligible(h)` from `skips[]` + standby promotion (plan Layer H) | block validity | flag day, as already planned |

Acceptance gate for S1′ (cheap and objective): over ≥ 1 000 blocks, **zero**
`QC-DIVERGENCE` warnings in S0′, and `/debug/statehash` identical on all nodes.

Because the chain is halted at 13,320,067, S0′ can be deployed with **no mixed-version
window**; S1′ activates at the `H_S` height already in the plan.

### 4.1 S0′ implementation status

S0′ is implemented and disabled by default. With `QC_SHADOW` unset, every added line
returns at `if (!consensus.qc.enabled)` before touching any decision.

| Piece | File | Notes |
|---|---|---|
| `quorumSize`, ledger, QC, `compareDecision`, `pruneLedger` | `src/consensusQuorum.js` | pure, no chain access, not `require`d by anything else |
| crash-safe vote record + INV-1 across restarts | `src/voteState.js` | atomic write, corrupt file detectable, `reset()` for rollbacks |
| shadow wiring | `src/consensus.js` | `qcObserve` (self + remote votes), `qcNoteOwnVote` (before `broadcast`), `qcCompare` (next to `possBlock[r].length`), FF threshold + FF-vs-lock checks |
| QC on the wire: `h` + `justify` | `src/consensus.js` | `endRound` sends the explicit height and, on the commit vote, the round-0 QC as `justify`; `qcRememberVote`/`qcBuildJustify`/`qcVerifyJustify` reap and re-verify it. Only compact hash-only votes are carried (the miner's own full-block vote is omitted — the block is already on the wire and its inclusion would blow up the payload) |
| observer/backup finalize gate | `src/consensus.js` | a non-voting node finalises on the QC alone (`isActive()` false ⇒ the round-0 self-vote is not required). This fixes a regression of the §4.2 fix: the local self-push was removed but `tryNextStep` still demanded it, so every non-leader node stopped finalising |
| monotone force-finalize votes | `src/consensus.js` | own and peer FF votes may only move towards a strictly better chain rank (`ffBetter`, `ffVote`); a downgrade is ignored |
| observability | `src/http/schedule`, `src/http/leader`, `src/http/allminers`, `src/http/block` | additive `epoch/set/standbys/jailed`, `streak/jailed/jailUntil/jailLevel`, `rank/eligible/jailed`, and `skips` in the apidoc |
| jail state in the leader index | `src/leaderStats.js` | `streak/absent/jailed/jailUntil/jailLevel` mirrored from `leaderHealth` (rebuildable, additive keys) |
| heartbeat | `scripts/heartbeat.js` | re-sends `ENABLE_NODE` (type 18) with the account's current leader key (§7.2) |

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `QC_SHADOW` | unset (off) | `1` = observe and log, never refuse |
| `VOTE_STATE_PATH` | `./state/vote_state.json` | where the vote record lives (local, never chain data) |

Log lines to grep (all prefixed `QC-`):

| Line | Severity | Meaning |
|---|---|---|
| `QC-SHADOW checked N divergences …` | info | heartbeat every 2 000 comparisons |
| `QC-DIVERGENCE … (production would finalise without a QC)` | warn | **the one that matters**: production accepted something the ledger cannot certify. The trailing clause names the cause (`counted but not eligible: …` = a local vote nobody received, or a local eligible set that misses a leader; `eligible votes never received: …` = a tally entry with no message behind it) |
| `QC-DIVERGENCE … (QC reached, production late)` | warn | wasteful direction, e.g. the observer `+1` |
| `QC-THRESHOLD-DIVERGENCE` | warn | the two quorum formulas disagree at this height (post-fix: only where the legacy one was lower, n ≥ 6) |
| `QC-FF-THRESHOLD-DIVERGENCE` | warn | force-finalize quorum differs from the legacy formula (only observable with the old formula still in the tree) |
| `QC-EQUIVOCATION` | info | a signer voted two hashes at the same `(h, r)`. Normal on a multi-candidate height; see §4.2 |
| `QC-FF-CONFLICT` | error | force-finalize would apply a hash this node precommitted against |
| `QC-VOTE-STATE behind head …` | warn | a rollback moved the head backwards: S1′ must call `voteState.reset()` |
| `QC-VOTE-STATE would refuse own vote …` | info/debug | what S1′ will refuse; `another candidate at this height` is the normal multi-candidate case |
| `QC-INTERNAL-ERROR …` | error | a shadow bug was caught by `qcGuard`; the block path was not affected |

Known S1′ prerequisite found while wiring this: `cache.rollback()` (called from
`chain.js:138`, `chain.js:495`, `consensus.js:137`, `p2p.js:581`) moves the head backwards,
so S1′ must call `voteState.reset()` there. S0′ only logs `QC-VOTE-STATE behind head` and
keeps voting, so the signal is visible but harmless.

### 4.2 What the first shadow run on a real testnet found

Run on `docker/testnet` + `docker-compose.qc-shadow.yml` (`avalon-qc`, 4 nodes, `QC_SHADOW=1`).

**Three defects blocked the run before any consensus measurement could happen.** They are
bugs in the harness/engine, not in the shadow wiring, and they are fixed:

| # | Symptom | Cause | Fix |
|---|---|---|---|
| D1 | bootstrap node crashed at block 0 (`consensus.qc.qcEligible is not a function`) | typo in the shadow wiring, thrown out of `tryNextStep` and into the block-validation chain | corrected call + `qcGuard()` around every shadow call site: shadow code can now only log |
| D2 | chain stuck at block 0 with **no** crash, `T3 R0-1 R1-0` forever | `threshold = max(floor(2n/3)+1, 3)`: the floor of 3 is unreachable with 1 leader, and the testnet has 1 leader at genesis | `blockQuorum(n)` = `quorumSize(n)` with the floor capped by `n` |
| D3 | chain stalled forever a few blocks later, `Slow performance detected, will not try to mine next block` | the only miner gives up its slot and schedules nothing, so nobody ever mines again | give up the slot only if another miner actually produced one of the last `2*config.leaders` blocks |

Two more real findings came out of the attempt:

* **D4 — force-finalize quorum was lower than the block quorum.** `_getQuorumThreshold()`
  was `min(ceil(config.leaders*2/3), max(ceil(activeCount*2/3), 3))`: at `activeCount = 6`
  it returned 4 (= exactly 2n/3) while block consensus already required 5. Force-finalize
  is a liveness backstop, not a cheaper consensus, so it now uses `blockQuorum(activeCount)`
  too. No change for n ≤ 5, so mainnet behaviour today is unchanged.
* **D5 — the docker testnet cannot survive `down`.** `mongod` leaves zombies and
  `docker stop` refuses to kill the container, so `down -v` fails and the next `up`
  reuses a half-dead mongo. Fixed with `init: true` in the qc overlay (worth adding to the
  stock compose too).

**Then the consensus measurement itself, and it says S1′ is not shippable as designed.**

Numbers from the run used to write this section: 4 nodes, 114 blocks, every node at the same
height, `restartCount=0` on all of them, zero errors from the block path.

| Observation | Count |
|---|---|
| `QC-INTERNAL-ERROR` (a shadow bug that reached `qcGuard`) | 0 |
| `QC-EQUIVOCATION` — a signer voted two hashes at the same `(height, phase)` | 4 (all on bootstrap, in the first slots where two leaders both proposed) |
| `QC-VOTE-STATE would refuse own vote` | 8 (bootstrap only) |
| `QC-DIVERGENCE` (unsafe direction), by node | 6 — bootstrap 1, miner1 0, miner2 3, miner3 2 |
| of those, cause `eligible votes never received` | 0 |
| of those, cause `counted but not eligible: <name>` | 6 |

The equivocations are **not** a bug and **not** an attack: Avalon votes on **every candidate
block** at a height. At a height where two leaders proposed, each node legitimately precommits
and commits both candidates, so one signer holds two hashes at the same `(h, r)` as a matter of
normal operation. `singleVote` (INV-1) is therefore *not* a property of this protocol: enforcing
it in S1′ — as designed — would make every node refuse to vote on the second candidate and
freeze heights with collisions. The shadow ledger consequently records votes with
`singleVote: false` (it must measure the protocol it has, not the one it wants) and reports the
double votes as a counter.

The divergences have a named cause, and it is worse than a counting artifact:

* `QC-DIVERGENCE … production 2/2 vs ledger 1/2 — counted but not eligible: <self>`
  — `consensus.round()` pushes the node's own name into `possBlock[round]` (`consensus.js:417`,
  `consensus.js:451`) **without broadcasting a vote** when the node is an observer. Production
  therefore finalises counting a vote that no peer ever received. All 6 divergences in the run
  above are of this shape: 5 on the node's own name, and 1 on `miner2` as seen by the bootstrap —
  the bootstrap's local `activeLeaders()` view had already dropped `miner2`, which is defect F2
  (the eligible set is a local view) showing up as a divergence.
* `QC-DIVERGENCE … — eligible votes never received: <name>`
  — the same mechanism for an eligible leader whose vote was locally pushed but whose message we
  never saw. Zero occurrences in this run, so the message path itself is sound.

So today's "quorum" is partly local: a block can be finalised on `threshold` entries of which
some were never transmitted. **The fixes above have been applied**: `endRound()` now records
and counts a node's own vote only when the node is active and actually broadcasts it; the
observer `+1` penalty is gone; and the local pushes at `consensus.js:417`/`consensus.js:451`
and `chain.js:164` have been removed.

On a real network with a stable leader set this makes the tally match the messages on the
wire. On the docker testnet it immediately exposed the next layer: after the fix the network
reaches block 55-60 and then the miners stop finalising, because their votes are rejected as
"wrong consensus signature" by peers whose local `activeLeaders()` view has not included them
yet (defect F2 from §2.3). Before the fix this was hidden by the phantom local votes: a node
could finalise without ever receiving the missing votes, so the schedules stayed loosely in
sync. After the fix the message path must be sound, and it is not — yet.

**Revised S1′ preconditions** (in this order, each one measurable with S0′ still on):

1. never count a local vote that was not broadcast — **done**;
2. never count an observer's own vote — **done**;
3. a deterministic, identical `eligible(h)` on every node — this is Layer S/H, and the
current run shows it is required before the previous two can be safe on a dynamic network;
4. one candidate per `(height, phase)` per signer, which requires the protocol to pick a
candidate per round — also Layer S/H;
5. only then can INV-1 be enforced and the gate re-stated as "zero divergences **of type
   unobserved/phantom**".

Point 3 is the important one: the "single quorum + locks" design is correct for a
one-candidate-per-round protocol with a shared eligible set, and Avalon is not one yet.
Shipping S1′ before Layer S/H would convert a theoretical safety gap into a practical halt.

The corrected gate for what is implemented today (S0′):

```
zero QC-INTERNAL-ERROR
zero QC-DIVERGENCE with a cause of "eligible votes never received" or "counted but not
  eligible" that is NOT the node's own non-broadcast vote
QC-THRESHOLD-DIVERGENCE only where the legacy formula is lower (n ≥ 6)
identical /count on every node
```

---

## 5. Tests

```bash
node test/quorum-lock.js    # 19 assertions: quorum, single-vote rule, lock, malformed input
node test/qc-shadow.js      # 14 assertions: production vs ledger verdict, blockQuorum
node test/vote-state.js     # 18 assertions: persistence, INV-1 across restarts
node test/qc-wiring.js      # 14 assertions: loads the REAL consensus.js with stubbed globals
node test/qc-justify.js     # 10 assertions: h + justify retention, verification, tamper, eligibility
node test/observer-finalize.js # 4 assertions: an observer finalises at q, a leader must precommit
node test/monotone-ff.js    # 4 assertions: monotone own/peer force-finalize votes
```

`qc-wiring.js` exists because the first testnet run crashed on a typo that no unit test could
have caught: `consensus.js` needs the globals `config`, `logr`, `chain`, `p2p`, `cache`, `dao`,
`daoMaster`, so the other three test files never load it. This one stubs those globals, requires
the real module in a child process and calls the whole shadow path — including a `qcGuard` case
that asserts a throwing shadow call is swallowed, counted and logged instead of killing the node.

`node test/quorum-lock.js` — no DB, no sockets, runs in ms:

* `quorumSize` is strictly > 2n/3 for n = 1…64, monotonic, fails closed at n = 0;
* equals the legacy FF formula at n = 3, 4, 5 (proves S1′ is a no-op today) and differs at
  n = 6 (proves the hole is real and Layer H activates it);
* eligible set is order-independent, de-duplicated, junk-tolerant;
* **the equivocation pair**: `singleVote: false` → two QCs at one height; `singleVote: true`
  → second QC impossible, equivocations recorded;
* 5 000 random interleavings, adversarial arrival order → never two QCs at one `(h, r)`;
* out-of-set signers never counted; repeated votes from one signer counted once;
* lock: refuses the competing precommit, is per height, does not block commit votes,
  duplicate vote is idempotent;
* malformed input (non-integer height, unknown phase, empty hash/signer, `null`) rejected.

Added with S0′: a Tamper test (a modified `justify` timestamp, a signature for another
hash, or an out-of-set signer → no QC) and a Restart test (kill between `endRound` and
broadcast → the node must refuse to re-vote the same `(h, r)`).

Still to add with S0′: replay 100 000 blocks and assert `qcHash` agrees with the production
path on every height; a Freshness test (a `justify` entry older than `2·blockTime` is still
accepted, while a stale envelope is not).

---

## 6. What this does not fix

| Gap | Needs |
|---|---|
| 2 of 5 leaders dead, denominator never drains | Layer S `skips[]` + Layer H standby promotion. INV-1 cannot create liveness out of 3/5. |
| schedule recomputed at restart (**F7**) | Layer S schedule persistence |
| `maxDrift = 200 ms` (**F4**), `SKIP_EARLY_CHECK_BLOCKS` (**F5**) | Layer S grace margin |
| no reorg / forward-only `recover()` (**F8**) | separate decision — INV-1 makes divergence *detectable*, not recoverable |
| non-deterministic state application (`cache.rollback`, Mongo, floats) | this is the one place where a CometBFT-style state-machine discipline is the right long-term answer — for a **new** chain, not for un-halting this one |

The honest summary: this draft makes Avalon's consensus **provable**, and reduces the
force-finalize machinery from "second protocol" to "fallback path with the same rules".
It does not make 5 validators fault-tolerant to 2 failures, because no protocol can.
