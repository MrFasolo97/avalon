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

- [~] 48h+ stable run with `LEADERS_OVERRIDE=3` (default prototype). *Needs long-running environment; helper scripts created.*
- [~] Kill a leader via `docker stop`, verify standby promotion after `N` misses. *Script `jail-kill.sh` created.*
- [~] Restart a jailed node and send heartbeat tx; verify un-jailing. *Script `jail-restart.sh` created.*
- [~] 2|2 partition via `iptables`/network namespaces. *Scripts `jail-partition.sh` / `jail-heal.sh` created.*
- [ ] Upgrade test: start chain without jail, activate jail params, verify continuity.
- [~] Restart all nodes one by one; verify no fork and lock files reloaded. *Persistent commit lock + jail index implemented; needs manual run.*

## 4. Productionization required before mainnet

- [x] Height-gated activation: `H_S`, `H_strict`, `H_standby` implemented in config + `healthParams()`.
- [x] Remove testnet carve-outs:
  - [x] `QUORUM_MIN=1` fallback replaced by bootstrap rule (`q = E` when `E < quorumMin` before `H_S`).
  - [x] `SKIP_STRICT`/`STANDBY_ENABLED` env booleans replaced by height-gated flags.
- [x] Persistent/checkpointed jail index (`src/jailIndex.js`, loaded in `main.js`).
- [x] Robust commit lock store: sync cleanup, corruption handling.
- [x] Heartbeat tx type 18: validation (sender must be registered leader), zero bandwidth fee, idempotent execution.
- [x] Logging and metrics: jail events, quorum changes, breaker fires, lock refusals exposed via `/leaderhealth`.
- [x] Peer handshake stability after restart: implemented periodic node_status refresh in `src/p2p.js`. *Live verification blocked by testnet bootstrap DB issue.*

## 5. Code quality / audit

- [x] Document every new consensus invariant (plan + prototype report + this checklist).
- [ ] External audit of `leaderHealth.js`, `consensus.js`, `chain.js` changes.
- [x] Fuzz test the pure kernel with random inputs (`test/fuzz.js`).
- [x] Property-based test: no two commits at same height without override (`test/fuzz.js` + `test/leader-jail.js`).

## 6. Mainnet rollout plan

- [x] Choose activation height far in the future (`H_S` >> current height). *Defaults set to planned flag-day heights in `config.js`; env override for testnet.*
- [~] Release candidate with activation height hardcoded. *Code supports it; final RC pending.*
- [ ] Validator communication and upgrade window.
- [ ] Canary nodes monitoring jail events, quorum, block times.
- [~] Emergency rollback procedure documented. *Rollback = new hard fork disabling jail via lower H_* heights; procedure in plan.*

---

## Current verdict

**Status: STILL NOT ready for mainnet, but significantly closer.**

Resolved in this pass:
- height-gated activation,
- removal of `QUORUM_MIN=1` and env-only booleans,
- persistent jail index + commit lock store,
- heartbeat validation/zero fee,
- fuzz/property tests,
- Docker helper scripts.

Remaining hard blockers:
- peer handshake stability after restart (§4),
- 48h+ Docker integration run (§3),
- external audit (excluded by request),
- validator communication + canary rollout (§6).
