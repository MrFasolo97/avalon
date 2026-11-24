# Summary of changes and new features on branch `new_net`

**Branch:** `new_net` of `/home/fasolo97/projects/dtube_all/avalon`  
**Current HEAD:** `3403afb` - `fix(consensus): prevent stale-head restarts from forking the chain`  
**Last change date:** 2026-11-20 18:36:02 +0100  
**Reference merge:** fast-forward from `ae936e6` (2025-09-20) to `3403afb`, incorporating the work of `feat/auto-force-finalize` and `feat/view-change`.  
**Tags touched:** `v2.0.0`, `v2.0.1`, `v2.0.2`, `v2.0.3`, `v2.1.0`, `v2.2.0`.  

The branch evolved from a transitional codebase to a mature release (v2.2.0) with hardened consensus mechanisms, security hardening, a structured testnet, monitoring and operational documentation. The main areas are below.

---

## 1. Security and hardening (audit + red team)

Main files: `src/http/ssrf.js`, `src/http/addPeer/index.js`, `src/http/image/index.js`, `src/http/opengraph/index.js`, `src/http/oembed/index.js`, `src/http/content/index.js`, `src/http/logs/index.js`, `src/http/auth/index.js`, `src/http/recover/index.js`, `src/http/transact*/index.js`, `src/cache.js`, `src/validate/*.js`, `src/mongo.js`, `src/transaction.js`.

New features:
- **Centralized SSRF protection** (`src/http/ssrf.js`) with IP validation, pinning, 5s DNS timeout, IPv4-mapped IPv6 protection.
- **Unified admin authentication** (`src/http/auth/index.js`) with IP-bound sessions, dedicated rate limiter, secret/token redaction in logs.
- **Rate limiting** on expensive endpoints and P2P (`src/http/index.js`, `src/p2p.js`).
- **NoSQL injection guards** in block query, cache, governance config merge (`src/cache.js`, `src/validate/*.js`).
- **Stricter JSON/input validation**: keys with `.`/`$` rejected, non-finite floats rejected, size measured in bytes not characters.
- **Shell/BSON security** in `scripts/auto_resolve_halt.sh`: no environment variable interpolation in `mongosh`, use of bash expansion, atomic state write.
- **Atomic state file write** to prevent TOCTOU corruption.
- **Red team fixes**: crash recovery, peer ban, blockSenders limits, caps on possBlocks/recentBlocks.

---

## 2. Consensus: forced finalization and anti-fork

Main files: `src/consensus.js`, `src/consensusQuorum.js`, `src/voteState.js`, `src/leaderHealth.js`, `src/chain.js`, `src/p2p.js`, `src/http/consensus/index.js`, `src/config.js`.

New features:
- **`forceFinalize`**: safety mechanism activatable at a consensus height. When the network stalls on conflicting blocks, leaders broadcast forced-finalization proposals, collect a quorum with signatures, and commit an agreed block.
- **Quorum-based finalize** with exponential backoff, signature verification, re-broadcast.
- **`forceFinalizeFallback`** (`config.js`): when `false` (default) the chain halts instead of risking a fork.
- **Flag day moved to ~13,325,000** to align with network rollout.
- **Layer S/H offline-leader hardening**: handling offline leaders, jail, standby promotion, ordered recovery after catch-up.
- **View-change / single-vote**: round-aware vote ledger and per-round precommit to avoid double votes in the same round.
- **Stale-head restart prevention** (`3403afb`): a leader restarted from a stale head can no longer mine a competing block already produced by a backup.
- **One-proposer gate** and **halt-stagger recovery** to avoid deadlock when all leaders are down.
- **Leader health** (`src/leaderHealth.js`) with active/inactive monitoring and rotation handling.

---

## 3. P2P and network resilience

Main files: `src/p2p.js`, `src/chain.js`.

New features:
- **Catch-up resilient** to rate-limit disconnects.
- **Chain divergence detected and reported** to peers.
- **NODE_STATUS** enriched with `pending_head`, recovery flag, release version (`package.json`).
- **Peer shuffle** and normalized keepalive, limited WebSocket payload size.
- **Pruning of stale possBlocks** to avoid halt after catch-up.
- **`addBlock` idempotency** for duplicate heights and in-memory check before MongoDB.

---

## 4. Monitoring and observability

Main files: `src/events.js`, `src/http/events/index.js`, `src/http/metrics/index.js`, `src/http/logs/index.js`, `scripts/avalon-watch.js`, `docker/testnet/monitoring/*`.

New features:
- **`/metrics` Prometheus** endpoint for scraping.
- **Structured events** (`src/events.js`) with Discord forwarding.
- **`avalon-watch.js`**: Discord watcher for operational alerts.
- **Log appender/buffer** (`src/logAppender.js`, `src/logBuffer.js`) with IP/stack trace redaction.
- **`/version` endpoint** to verify the active release.
- **Prometheus alerts** and drill dashboards in the testnet.

---

## 5. Testnet and drills

Folder: `docker/testnet/`.

New features:
- **Multi-node Docker setup** with shared MongoDB, Node 18/24 image, ports 3101-3104 / 6101-6104.
- **Automated genesis and kickstart** (`scripts/testnet-genesis.sh`, `testnet-miner.sh`, `setup-testnet.js`, `patch-config.js`).
- **Drills G1-G13**:
  - G1: one leader down for 60 blocks
  - G2/G3: leader jailed
  - G4: standby promotion
  - G5: network partition
  - G6: clock skew
  - G7: equivocation
  - G8: asymmetric force finalize
  - G9: old node
  - G10: all leaders down
  - G11: halt breaker recovery
  - G12: halt breaker off
  - G13: stale leader restart
- **S4 migration testnet** (`docker/testnet/docker-compose.migrate.yml`, `scripts/s4-*`).
- **QC shadow net** for parallel testing without interfering with mainnet.

---

## 6. Operational tooling and documentation

Main files: `scripts/start.sh`, `scripts/auto_resolve_halt.sh`, `scripts/upgrade-preflight.js`, `scripts/heartbeat.js`, `doc/*.md`.

New features:
- **`scripts/start.sh`**: standardized node startup.
- **`auto_resolve_halt.sh`**: emergency script for chain halt with manual (`doc/v1.5.2-upgrade.md`).
- **`upgrade-preflight.js`**: pre-upgrade checks before deployment.
- **`heartbeat.js`**: liveness signal for orchestrators.
- **Runbooks**:
  - `doc/mainnet-deployment-and-rollback.md`
  - `doc/migration-runbook-no-econs.md` (and English version `.en.md`)
  - `doc/public-testnet.md`
  - `doc/testnet-migration-test.en.md`
  - `doc/monitoring.md`
  - `doc/consensus-offline-leaders-plan.en.md`
  - `doc/consensus-single-quorum-and-locks.en.md`
  - `doc/view-change-design.en.md`
- **Updated README** with setup, API and admin authentication.

---

## 7. Economics fork #13330000 (implemented but EXCLUDED from the release)

- Commit `46c77ff` introduced the economics hard fork (supply-anchored pool, vote rate cap, `pow10`/`ipow`).
- Commit `366cf1f` (`revert(econs): exclude hard fork #13330000 from the v2.1 release`) removed the active code from `src/`.
- The reference documentation remains in `doc/economics_fork_13330000.md`.
- **In the current `new_net` branch the economics fork is NOT active.**

---

## 8. Tests

Added ~25 new files in `test/`:
- `audit-fixes.js`, `force-finalize.js`, `force-finalize-fetch.js`, `monotone-ff.js`
- `consensus-*.js` (endpoint, invariants, layer-h, qc-*, quorum-lock, vote-state)
- `leader-health.js`, `schedule-*.js`, `poss-block-prune.js`, `pending-blocks.js`
- `halt-breaker.js`, `observer-finalize.js`, `skip-*.js`
- `events.js`, `image-sharp.js`, `block-rank.js`
- `tests/test_dao.js`

---

## 9. Infra and dependencies

- **Node.js >=24** required; Dockerfile and runtime aligned.
- **`javalon2` updated** to `^1.1.10` (DMCA fallback fix, no consensus impact).
- **`sharp` updated** to `^0.35.5`.
- **`package-lock.json` tracked**.
- **GitHub Actions CI** (`/.github/workflows/ci.yml`) for lint and tests.
- **Released versions**: v2.0.0, v2.0.1, v2.0.2, v2.0.3, v2.1.0, v2.2.0.

---

## Operator notes

- `new_net` is now aligned with `v2.2.0` and includes Layer S/H + view-change.
- Economics fork #13330000 is not enabled: migration from `new_net` to the new code follows the **no-econs** runbook.
- To verify the active version: `GET /version` once the node is running.
- For tests: `npm test` and `npm run lint` (currently 0 errors).