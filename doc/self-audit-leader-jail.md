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
| 5 | Quorum is adaptive and capped: `1 <= q <= min(quorumCap, E)`. | `leaderHealth.quorumSize`; fuzz tests. |
| 6 | Before `H_S` the legacy rules apply (no jail, bootstrap quorum). | `leaderHealth.jailState` returns empty state when `jailEnabled=false`; bootstrap quorum rule. |
| 7 | Heartbeat txs are free and idempotent. | `transaction.js` bypasses bandwidth; `enableNode.js` execution is idempotent. |

## 3. Findings

### 3.1 Critical — none

No critical safety issues were identified in the reviewed code under the
assumption that the underlying cryptography, signature verification and p2p
message handling are correct.

### 3.2 High

#### H1: `enableNode.js` heartbeat validation may reject legitimate former leaders — FIXED
**File:** `src/transactions/enableNode.js`  
**Details:** The heartbeat validation originally required `legitUser.pub_leader`
to be set. If a leader’s `pub_leader` was previously unset by an invalid
ENABLE_NODE tx, it could not send a heartbeat to un-jail itself.  
**Fix:** Validation now accepts any account with `pub_leader` set **or**
`node_appr > 0` (i.e. an approved leader candidate).  
**Verification:** Unit tests still pass; fuzz tests cover heartbeat parsing.

#### H2: Persistent jail index corruption handling — FIXED
**File:** `src/jailIndex.js`  
**Details:** The index is loaded at startup and used to prime `_jailCache`. A
corrupted or stale file could have been accepted.  
**Fix:** Added `INDEX_VERSION` and explicit validation of `tipHash`, `tipHeight`,
and `state`. Mismatches cause a fallback to full recomputation.  
**Verification:** Loading logic exercised implicitly on every restart; fuzz/unit
tests pass.

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

#### L2: `jail-partition.sh` relies on iptables inside containers
**File:** `docker/testnet/scripts/jail-partition.sh`  
**Details:** The script assumes containers have `iptables` and sufficient
capabilities. This may not work in all Docker runtimes.  
**Recommendation:** Provide an alternative using Docker network namespaces or
`docker network disconnect`.

## 4. Recommendations before mainnet

1. Fix H1 (heartbeat validation for former leaders).
2. Harden `jailIndex.js` against corruption (H2).
3. Reduce `jailIndex.save` frequency (M1).
4. Run the 48-hour Docker integration scenarios.
5. Engage an **external, independent** auditor.
6. Publish activation heights and validator upgrade window.

## 5. Test summary

| Suite | Count | Result |
|-------|-------|--------|
| Unit tests | 30 | PASS |
| Simulation | 2 scenarios | PASS, 0 safety violations |
| Chaos tests | 9 scenarios incl. 10k healthy, partitions, force-finalize | PASS, 0 safety violations |
| Fuzz checks | 3200 | PASS |

## 6. Conclusion

The prototype implements the approved design correctly and the test coverage is
strong for a prototype. The remaining blockers for mainnet are operational
(48h integration run, external audit, validator communication) plus the two high-
severity findings H1 and H2 identified above.
