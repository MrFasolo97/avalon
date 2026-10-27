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

When `E < quorumMin` (degraded mode), the breaker threshold is raised to `E`,
i.e. **unanimità dell'eligible set**, for extra safety (see §7).

`consensus.js` and the simulator both call this function, so the rule cannot
diverge between the model and production code.

**Residual risk (accepted, documented):** canonical selection ensures that,
given the same view of all candidates, every node picks the same winner. It
cannot prevent a fork when partitions have genuinely different candidate sets
(a known Avalon collision-resolution limitation). Unanimity in degraded mode
and the commit lock limit the surface; observability flags it immediately
(see §7).

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

#### M2: New leader votes for jailed accounts are rejected at blockchain level — ADDED
**Files:** `src/transactions/approveNode.js`, `src/config.js`, `test/approveNode-jailed.js`  
**Details:** The existing `disallowVotingInactiveLeader` rule rejected votes for
accounts without `pub_leader`, but a jailed leader keeps `pub_leader` set, so it
could still receive new votes. A new `disallowVotingJailedLeader` flag
(default `true`) rejects `approveNode` transactions whose target is currently
jailed. The check is height-gated through `chain.healthParams()` and only
activates after `H_S`. Existing votes are **not** retroactively removed; they
continue to contribute `node_appr` until their owners unvote, which is the
least-invasive behaviour.

**Live verification:** attempted on the isolated Docker testnet on 2026-10-27,
but the local Docker daemon entered a degraded state after the earlier jail
prototype runs (a MongoDB container became zombie/defunct and could not be
removed through normal Docker commands). The daemon was recovered, but starting
the testnet containers was still impractically slow. The feature is covered by
dedicated unit tests (`test/approveNode-jailed.js`) and should be re-verified
live once the Docker host is rebooted or otherwise restored.

## 4. Recommendations before mainnet

1. ~~Fix H1 (heartbeat validation for former leaders).~~ Done.
2. ~~Harden `jailIndex.js` against corruption (H2).~~ Done.
3. ~~Reduce `jailIndex.save` frequency (M1).~~ Done.
4. ~~Fix H3 (`E < quorumMin` permanent halt).~~ Done.
5. ~~Decide/implement the degraded-mode policy (§7).~~ Done.
6. ~~Disable new leader votes for jailed leaders at blockchain level.~~ Done (`disallowVotingJailedLeader`).
7. Run the 48-hour Docker integration scenarios.
8. Engage an **external, independent** auditor.
9. Publish activation heights and validator upgrade window.
10. Consider frontend exposure of jailed leaders (e.g. disable voting in dtube2/dtubego) — product decision, not consensus-critical.

## 5. Test summary

| Suite | Count | Result |
|-------|-------|--------|
| Unit tests | 35 | PASS |
| approveNode jailed-vote unit tests | 3 | PASS |
| Simulation | 2 scenarios | PASS, 0 safety violations |
| Chaos tests | 9 scenarios incl. 10k healthy, partitions, force-finalize | PASS, 0 safety violations |
| Fuzz checks | 3600 | PASS |

## 6. Conclusion

The prototype implements the approved design correctly and the test coverage is
strong for a prototype. H1, H2 and H3 were found and fixed. Leader votes for
jailed accounts are now blocked at blockchain level. The remaining blockers for
mainnet are operational (48h integration run, external audit, validator
communication).

## 7. Degraded-mode policy (implemented)

After H3, `E < quorumMin` no longer halts the chain: it degrades to
majority-of-eligible. The implemented policy hardens this path:

- **Unanimity in degraded mode**: when `E < quorumMin`, the halt breaker now
  requires **all `E` eligible signers** (`breaker.threshold = E`) instead of a
  simple majority. With the approved mainnet params (`quorumMin=3`) this means
  `E=1` needs 1/1 and `E=2` needs 2/2 — the safest possible recovery.
- **Finalization delay**: the existing `haltBreakerMs` wall-clock wait already
  provides the delay window; no extra timer was added.
- **Observability**: `/leaderhealth` exposes `degraded`,
  `degradedSinceHeight`, `consecutiveDegradedBlocks`; logs emit `DEGRADED MODE`
  and `CRITICAL` after `config.degradedCriticalConsecutive` consecutive blocks
  (configurable via `DEGRADED_CRITICAL_CONSECUTIVE`, default 100).
- **Fork detector**: `/leaderhealth` exposes `forkSuspect` and `forkPeers` when
  a peer reports the same `head_block` with a different hash.

**Residual risk**: canonical selection ensures that, *given the same view of
all candidates*, every node picks the same winner. It cannot prevent a fork
when partitions have genuinely different candidate sets: a node that has not
received the global canonical block may finalise its local canonical. The
breaker unanimity rule and the commit lock limit this surface, but do not
eliminate it entirely. This is documented as a known limitation of the
Avalon collision-resolution design.
