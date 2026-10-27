# Self-audit report: offline-leader jail prototype

> This is an **internal / self-audit**. It was produced by the same agent that
> wrote the code, so it is **not independent** and cannot replace an external
> audit. Its purpose is to document invariants, findings and recommended fixes
> before engaging an external reviewer or deploying to mainnet.
>
> Scope: `feat/leader-jail-prototype` as of the commit that added this file.
> Excluded: external audit (deliberately not performed by this agent).

## 1. Methodology

- Manual review of `src/leaderHealth.js`, `src/consensus.js`, `src/chain.js`,
  `src/p2p.js`, `src/commitLockStore.js`, `src/jailIndex.js`,
  `src/transaction.js`, `src/transactions/enableNode.js`.
- Static reasoning about consensus invariants.
- Test evidence: 30 unit tests, simulation, chaos scenarios, 3200 fuzz checks.
- Comparison against the approved plan in
  `doc/consensus-offline-leaders-plan.en.md`.

## 2. Invariants verified

| # | Invariant | Evidence |
|---|-----------|----------|
| 1 | A node commits at most one hash per height. | `leaderHealth.commitDecision` + `src/commitLockStore.js`; unit + chaos tests. |
| 2 | Two conflicting blocks cannot both finalise under a network partition. | Breaker threshold = majority of eligible set; commit lock; partition sims pass. |
| 3 | A jailed leader is excluded from rotation and quorum denominator. | `leaderHealth.eligibleLeaders`, `leaderHealth.isJailed`; unit tests. |
| 4 | Standbys are promoted only when a leader is jailed and Layer H is active. | `leaderHealth.ladderFor`, `chain.healthParams` height-gated `standbyEnabled`. |
| 5 | Quorum is adaptive and capped: `q = min(quorumCap, max(quorumMin, E))`. | `leaderHealth.quorumSize`; fuzz tests. Note: `q` may exceed `E` when `E < quorumMin`; invariant 8 is the required safety valve. |
| 6 | Before `H_S` the legacy rules apply (no jail, bootstrap quorum). | `leaderHealth.jailState` returns empty state when `jailEnabled=false`; bootstrap quorum rule. |
| 7 | Heartbeat txs are free and idempotent. | `transaction.js` bypasses bandwidth; `enableNode.js` execution is idempotent. |
| 8 | Whenever at least one leader is eligible, a recovery path exists (no permanent halt). | `leaderHealth.breakerRecovery`, used by `consensus.js` and `test/simulation.js`; unit + fuzz tests; live testnet regression of 2026-10-27. |

## 3. Findings

### 3.1 Critical — none

No critical safety issues were identified in the reviewed code under the
assumption that the underlying cryptography, signature verification and p2p
message handling are correct.

### 3.2 High

#### H1: `enableNode.js` heartbeat validation may reject legitimate former leaders — FIXED
**File:** `src/transactions/enableNode.js`  
**Details:** The heartbeat validation originally required `legitUser.pub_leader`
to be set. This broke initial leader registration (the account has no leader
key yet) and could lock out a leader whose key was temporarily unset.  
**Fix:** Validation now accepts any existing, validly-signed account. The jail
kernel only processes heartbeats from jailed senders, so random accounts cannot
abuse the zero-bandwidth path to affect consensus.  
**Verification:** Unit tests still pass; fuzz tests cover heartbeat parsing.

#### H2: Persistent jail index corruption handling — FIXED
**File:** `src/jailIndex.js`  
**Details:** The index is loaded at startup and used to prime `_jailCache`. A
corrupted or stale file could have been accepted.  
**Fix:** Added `INDEX_VERSION` and explicit validation of `tipHash`, `tipHeight`,
and `state`. Mismatches cause a fallback to full recomputation.  
**Verification:** Loading logic exercised implicitly on every restart; fuzz/unit
tests pass.

#### H3: `E < quorumMin` was a permanent halt (breaker required a missing signer) — FIXED
**Files:** `src/consensus.js`, `src/leaderHealth.js`, `test/simulation.js`  
**Details:** The halt breaker refused to run when every eligible leader had
already signed (`missing = 0`):

```js
if (signers.length < minSigners || missing < 1 || missing > maxMissing) return
```

That condition made the only state in which the breaker is *structurally
necessary* — `E < quorumMin`, where the normal quorum `q = quorumMin` can never
be reached — unrecoverable. Once the eligible set collapses below `quorumMin`,
no block can be produced, heartbeats cannot be included, and the chain halts
forever. Reproduced live on the isolated testnet on 2026-10-27 at height 514:
a single height recorded two skips (`skips: ["miner2","miner1"]`, 500 ms
`skipGraceMs` on a loaded host), leaving `E=1` with `q=3`:

```
T3 R0-1 R1-0
haltBreaker: recovery not possible at height 514 (signers=1/1 need>=1 missing<=0)
```

**Fix:** the rule is now a pure, shared kernel function
`leaderHealth.breakerRecovery(E, S)`:

- recovery is allowed iff `S >= breakerThreshold(E)` (a majority of the eligible
  set, as documented in the plan) **and** `E >= 1`;
- `missing === 0` is a valid recovery case ("all-eligible-signed"), not an error;
- `E = 0` (all leaders jailed) still halts: no eligible signer exists.

`consensus.js` and the simulator both call this function, so the rule cannot
diverge between the model and production code.

**Residual risk (accepted, documented):** allowing `missing === 0` means that
when `E` collapses to 1, a single eligible leader can finalise. Nodes that see a
different eligible set can only finalise candidates signed by *their* eligible
majority, so both sides cannot finalise conflicting candidates unless they
disagree on eligibility *and* each sees a majority of its own set. The commit
lock still forbids a double commit per node. This is the same relaxation the
plan already accepted for the breaker; it is now reachable in the `E=1` case,
which is why degraded operation must be observable and bounded (see §7).

**Verification:** 35 unit tests (5 new for `breakerRecovery`), 3600 fuzz checks
(new majority property, 400 iterations), simulation and chaos scenarios still
report 0 safety violations (including the 2|2 partition with `E=4`, where
`S=2 < breakerThreshold(4)=3` continues to halt both sides).

### 3.3 Medium

#### M1: Frequent disk writes from `jailIndex.save` — FIXED
**File:** `src/chain.js`  
**Details:** `jailState()` saved the index every time it was called for the tip.  
**Fix:** Added `chain._jailIndexSavedHeight`; the index is now persisted at most
once per tip height.

#### M2: `p2p.broadcastNodeStatus` does not validate responses against a timeout
**File:** `src/p2p.js`  
**Details:** The periodic status refresh re-uses `challengeHash` but does not set
a new `pendingDisconnect`. A malicious or slow peer could ignore the request
without consequence.  
**Risk:** Stale peer information persists longer than necessary.  
**Recommendation:** Optional: track last status refresh per peer and disconnect
peers that do not reply within a few intervals.

### 3.4 Low / Informational

#### L1: Testnet default `H_S=0` in compose means all features are active from genesis
**File:** `docker/testnet/docker-compose.jail.yml`  
**Details:** This is intentional for the isolated testnet, but it differs from
mainnet behavior. Operators must verify mainnet heights before deploying.  
**Recommendation:** Document the difference prominently in the runbook.

**Update 2026-10-27:** the compose now uses `H_S=H_strict=H_standby=200` so the
bootstrap carve-out (`q = E` while `E < quorumMin`) can finalise the
single-leader genesis, and all layers then activate together at block 200. Note
the env var casing: `H_S`, `H_strict`, `H_standby` — not `H_STRICT`/`H_STANDBY`.

#### L3: Testnet pairs `LEADERS_OVERRIDE=3` with `QUORUM_MIN=3`
**File:** `docker/testnet/docker-compose.jail.yml`  
**Details:** With three leaders, `q = max(quorumMin, E)` is unreachable as soon
as one leader is not eligible, so the testnet runs in breaker-degraded mode far
more often than mainnet will (`leaders=5, quorumMin=3`). For a 3-leader rotation
`QUORUM_MIN=2` is the majority rule and keeps the testnet closer to a healthy
mainnet. Left unchanged for now because the current value is what exercises the
recovery path.

#### L2: `jail-partition.sh` relies on iptables inside containers
**File:** `docker/testnet/scripts/jail-partition.sh`  
**Details:** The script assumes containers have `iptables` and sufficient
capabilities. This may not work in all Docker runtimes.  
**Recommendation:** Provide an alternative using Docker network namespaces or
`docker network disconnect`.

## 4. Recommendations before mainnet

1. ~~Fix H1 (heartbeat validation for former leaders).~~ Done.
2. ~~Harden `jailIndex.js` against corruption (H2).~~ Done.
3. ~~Reduce `jailIndex.save` frequency (M1).~~ Done.
4. ~~Fix H3 (`E < quorumMin` permanent halt).~~ Done.
5. Decide the degraded-mode policy (§7) and implement it.
6. Run the 48-hour Docker integration scenarios.
7. Engage an **external, independent** auditor.
8. Publish activation heights and validator upgrade window.

## 5. Test summary

| Suite | Count | Result |
|-------|-------|--------|
| Unit tests | 35 | PASS |
| Simulation | 2 scenarios | PASS, 0 safety violations |
| Chaos tests | 9 scenarios incl. 10k healthy, partitions, force-finalize | PASS, 0 safety violations |
| Fuzz checks | 3600 | PASS |

## 6. Conclusion

The prototype implements the approved design correctly and the test coverage is
strong for a prototype. H1, H2 and H3 were found and fixed. The remaining
blockers for mainnet are operational (48h integration run, external audit,
validator communication) plus the degraded-mode policy in §7.

## 7. Open design decision: degraded-mode policy

After H3, `E < quorumMin` no longer halts the chain: it degrades to
majority-of-eligible, and at `E = 1` a single leader finalises. That is the
plan's documented breaker relaxation, but it must not be silent or unbounded.
Two candidate policies were evaluated; the recommended one is (C):

- **(B) Raise the skip grace / exclude only jailed leaders from `E`.**
  Symptomatic: it reduces the frequency of `E` collapse but not the structural
  case (`leaders=3, quorumMin=3` cannot reach `q` with one ineligible leader),
  it changes a consensus-relevant rule (needs its own flag day), and removing
  the `streak > 0` exclusion would turn every real death into one breaker round
  per block until the jail threshold is reached.
- **(C) Keep the eligibility rule and make degraded operation explicit.**
  Emit a `degraded` flag from `/leaderhealth`, a metric and an operator alert
  whenever `E < quorumMin`, and bound it (e.g. halt after K consecutive degraded
  blocks and require operator action). This keeps the fast, deterministic
  quorum shrink, makes the safety relaxation visible in real time, and does not
  mask the underlying liveness problem.

Status: **not implemented** — pending decision.
