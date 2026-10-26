# Mainnet readiness checklist for leader jail + force-finalize

> Branch: `feat/leader-jail-prototype` (forked from `feat/auto-force-finalize`).
> Goal: know when this code is safe to merge into `new_net` and deploy on mainnet.

Legend: `[ ]` open, `[~]` in progress, `[x]` done, `[-]` not applicable / deferred.

---

## 1. Pure-kernel correctness (`src/leaderHealth.js`)

These tests can run offline and must pass deterministically.

- [x] Ladder construction with active + standby leaders.
- [x] Miss streak tracking and jail backoff (`jailMissThreshold`, `jailBlocks`, `jailBackoffMax`).
- [x] Adaptive quorum: `q = min(quorumCap, max(quorumMin, E))`.
- [x] Breaker threshold = majority of eligible set (`floor(E/2)+1`).
- [x] Commit lock: allow first hash, refuse second hash, allow breaker override.
- [x] Standby promotion when active leader is jailed.
- [x] Heartbeat un-jailing (tx type 18 parsed by `jailState`).
- [x] Edge cases: `E=1`, `E=2`, `E=3`, all jailed.

## 2. Simulation / discrete-event tests (`test/simulation.js`)

Run with mainnet-like params compressed in time.

- [x] Healthy run, 1000 blocks.
- [x] Kill one leader, observe jail + standby promotion.
- [x] 2|2 partition with `E=4`: both sides halt, no fork, converge after heal.
- [x] Long run: 10,000 blocks healthy.
- [x] 1|3|1 partition with `E=5`.
- [x] 2|2|1 partition with `E=5`.
- [x] Asymmetric partition: 1|4 (1|3 deferred).
- [x] Variable delays / jitter.
- [x] Random chaos: kill/revive nodes, partition/heal, no safety violations.
- [x] Force-finalize interaction: node forces finalization under breaker.
- [x] Commit lock crash/recovery: reload locks and verify no double-sign.

## 3. Integration tests on isolated Docker testnet

- [ ] 48h+ stable run with `LEADERS_OVERRIDE=3` (default prototype).
- [ ] Kill a leader via `docker stop`, verify standby promotion after `N` misses.
- [ ] Restart a jailed node and send heartbeat tx; verify un-jailing.
- [ ] 2|2 partition via `iptables`/network namespaces.
- [ ] Upgrade test: start chain without jail, activate jail params, verify continuity.
- [ ] Restart all nodes one by one; verify no fork and lock files reloaded.

## 4. Productionization required before mainnet

- [ ] Height-gated activation: implement `H_S`, `H_strict`, `H_standby` enforcement in code.
- [ ] Remove testnet carve-outs:
  - `QUORUM_MIN=1` fallback,
  - env-only params that should be chain constants.
- [ ] Persistent/checkpointed jail index (avoid full chain scan each block).
- [x] Robust commit lock store: sync cleanup, corruption handling (atomic append via `appendFileSync`).
- [~] Heartbeat tx type 18: validation, zero fee, idempotency (parsed by kernel; gateway wiring pending).
- [x] Logging and metrics: jail events, quorum changes, breaker fires, lock refusals exposed via `/leaderhealth`.
- [ ] Peer handshake stability after restart (currently testnet shows `head_block: 0` issue).

## 5. Code quality / audit

- [ ] Document every new consensus invariant.
- [ ] External audit of `leaderHealth.js`, `consensus.js`, `chain.js` changes.
- [ ] Fuzz test the pure kernel with random inputs.
- [ ] Property-based test: no two commits at same height without override.

## 6. Mainnet rollout plan

- [ ] Choose activation height far in the future (`H_S` >> current height).
- [ ] Release candidate with activation height hardcoded.
- [ ] Validator communication and upgrade window.
- [ ] Canary nodes monitoring jail events, quorum, block times.
- [ ] Emergency rollback procedure documented.

---

## Current verdict

**Status: NOT ready for mainnet.**
Open blockers: items in §2 (long/chaos/partition sims), §4 (productionization), §5 (audit).
