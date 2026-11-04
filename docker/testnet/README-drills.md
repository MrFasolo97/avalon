# Avalon Testnet — Layer S/H Offline-Leader Drills

A testnet extended to **5 leaders + 2 standbys** to run the G1–G12 matrix from
`doc/consensus-offline-leaders-plan.en.md`.

## Requirements

- Docker + Docker Compose v2
- ~8 GB RAM (8 nodes: bootstrap, setup, mongodb, 5 miners, 2 standbys)

## Start

```bash
cd docker/testnet

# Build
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml build

# Start
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml up -d

# Logs
docker compose -p avalon-drills logs -f
```

Startup follows the same flow as the base testnet:
1. `bootstrap` — genesis and first blocks
2. `setup` — creates 7 accounts (`miner1..miner5`, `standby1..standby2`), transfers tokens, enables the nodes, votes the leaders
3. `miner1..miner5` — initial leader set
4. `standby1..standby2` — standby pool (canonical name ordering places them after the miners)

## Host ports

| Service   | HTTP  | P2P   |
|-----------|-------|-------|
| bootstrap | 3201  | 6201  |
| miner1    | 3202  | 6202  |
| miner2    | 3203  | 6203  |
| miner3    | 3204  | 6204  |
| miner4    | 3205  | 6205  |
| miner5    | 3206  | 6206  |
| standby1  | 3207  | 6207  |
| standby2  | 3208  | 6208  |

## Useful commands

```bash
# Current height
watch -n 1 'curl -s http://localhost:3201/count'

# Consensus state (leader health, quorum, possBlocks)
curl -s http://localhost:3201/consensus | jq

# Cross-node determinism hash
curl -s http://localhost:3201/debug/statehash | jq '.stateHash'
curl -s http://localhost:3202/debug/statehash | jq '.stateHash'

# Peer list
curl -s http://localhost:3201/peers

# Current schedule
curl -s http://localhost:3201/schedule | jq
```

## Drill matrix G1–G12

| Id | Scenario | Example command | Expected |
|----|----------|-----------------|----------|
| G1 | 1 leader down for 60 blocks | `docker stop avalon-drills-miner5` for 60s | chain continues, correct `skips`, no jail |
| G2 | 1 leader down for 200 blocks | `docker stop avalon-drills-miner5` for ~600s | jailed after 30 turns, `E=4/q=4`, no halt |
| G3 | 2 leaders down for 400 blocks | `docker stop avalon-drills-miner4 avalon-drills-miner5` | jailed, `E=3/q=3`, chain continues |
| G4 | Top-5 down, standby enters (Layer H) | `docker stop avalon-drills-miner5` for >30 turns | `standby1` enters at the next epoch, produces at 3s |
| G5 | 3/2 partition for 100 blocks | isolate 2 nodes from the Docker network | majority finalises, minority resyncs |
| G6 | ±5s clock skew on two nodes | `docker exec ... date -s ...` | blocks held in pending, then accepted, no ban |
| G7 | Equivocation | two near-simultaneous `/mineBlock` | deterministic rank picks one block, no fork |
| G8 | Force-finalize with asymmetric views | fast kill/restart | fetch path converges, no halt |
| G9 | Old node during S1/H1 | start a `v2.0.x` tag | S1: follows; H1: stalls and resyncs, never forks |
| G10 | All 5 leaders down | `docker stop avalon-drills-miner{1..5}` | deterministic halt, no fork |
| G11 | 2 leaders killed in the same round | `docker kill` two miners | after ~21s the haltBreaker runs a recovery round with 3/3 unanimity |
| G12 | 3 leaders killed, HALT_BREAKER=0 | like G11 with the env off | deterministic halt, restarting one node resumes |

## Stop everything

```bash
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml down -v
```

## Notes

- Layer S/H is active from block **100** (`patch-config-testnet.js`).
- `ADMIN_ALLOW_ANONYMOUS=1` allows token-less `/mineBlock` locally only.
- `leaderHealth` state is rebuildable from the blocks; `/consensus` exposes it live.

## Drill results (run 2026-11-03/04 — full matrix)

Testnet rebuilt from genesis with **2 standbys** and the fixes below, then the
G1–G12 matrix.

| Drill | Result | Notes |
|-------|--------|-------|
| G1  | PASS | 1 leader down for 60 blocks, chain continues, correct `skips`, statehash ok |
| G2  | PASS | 1 leader jailed after 30 turns, `E=4`, statehash matches |
| G3  | PASS | 2 leaders jailed, excluded from the eligible set, chain continues |
| G4  | PASS | `standby1` promoted into `activeLeaderSet` at the next epoch |
| G5  | PASS | 3/2 partition: the majority finalises, the minority resyncs |
| G6  | PASS | ±5s clock skew via **libfaketime** (host clock untouched) |
| G7  | PASS | equivocation: deterministic rank, the chain converges |
| G8  | PASS | force-finalize with asymmetric views: converges, no halt |
| G9  | PASS | `v2.0.3` node (new script): never a divergent block |
| G10 | PASS | all leaders down → the chain **resumes**, no fork |
| G11 | PASS | halt breaker: 2 leaders killed, recovery round, statehash matches |
| G12 | PASS | breaker off: deterministic halt, the restart resumes |

**Result: 12/12 PASS, 0 FAIL.**

### Fixes applied

- **`leaderMaxVotes` 7 → 8** (`patch-config-testnet.js`). The master approves
  itself (`approves: ["dtube","miner1"…"standby1"]`), so with 7 slots `standby2`
  never received a `node_appr` and the testnet had **a single standby**.
- **F2 — `eligibleLeaders()` derived from the chain** (`src/consensus.js`). It used
  to call `activeLeaders()`, which walks the **local** `recentBlocks` and can
  differ by a block between nodes: the quorum threshold ended up different (q=3 on
  one node, q=4 on another) and one group finalised a block the other still needed
  a vote for → permanent fork after a total halt. The base is now
  `chain.activeLeaderSet()` (a rotation identical on every node).
  **Genesis caveat:** the rotation must be used **only after** the master has left
  the schedule. During bootstrap the master is the scheduled leader and must stay
  eligible, otherwise the fresh chain deadlocks at the first epoch after the
  miners are voted in (the "master" schedule cannot be regenerated because the
  block that would regenerate it is the one being blocked). The fix is therefore
  conditional: while `chain.schedule.shuffle` still contains the master, the
  historical behaviour is used; then the deterministic rotation.
- **Deterministic `/debug/statehash`** (`src/http/debug/index.js`). It hashed the
  cumulative `leaderHealth` counters (`produced`/`missed`, dependent on the local
  rebuild window: 641 vs 456) **and** `consensus.activeLeaders()` (local view) →
  false divergence alarms at identical blocks. It now hashes only the
  consensus-relevant fields, with sorted names, and both lists derive from the
  chain (`activeLeaderSet()`).
- **MongoDB connection retry** (`src/mongo.js`). A node restarted together with
  MongoDB (coordinated resume / flag day) reached `init()` before mongo was ready
  and did `process.exit(1)`: half the network crashed on every restart. It now
  retries with backoff (30 × 2 s) before giving up.
- **Effective `haltBreaker` flag** (`src/http/consensus/index.js`). `/consensus`
  reported `config.haltBreaker`, not the per-node `HALT_BREAKER=0` override; it now
  reports the value actually in force (needed by G12).
- **Crash guard in `consensus.round()`** (`src/consensus.js`). A malformed
  `NEW_BLOCK` (without `hash`) reached `block.hash.substr(...)` and threw
  `TypeError: Cannot read properties of undefined (reading 'substr')`: the node died
  and, through the P2P relay, **half the network** fell mid-drill. A block without a
  valid `hash` is now refused.
- **Exception-proof `keepAlive`** (`src/p2p.js`). It is an async chain that
  re-schedules **at the end**; an exception in the middle broke it and the node
  **never** reconnected to its PEERS → miners with **0 peers** after a full restart
  (bootstrap included) → stall. It also skipped a peer when `dns.lookup` failed. The
  body is now wrapped in `try/catch` with re-scheduling in `finally`, and on a
  failed DNS lookup it still attempts the connection. Validated: after restarting
  all nodes, peers return within ~25 s.
- **Idempotent suite — `settle_testnet`** (`lib.sh` + `run-all-drills.sh`). Before
  each drill it restarts any container left down and waits for the chain to advance
  again. Without it, an interrupted drill left a node down and cascaded into every
  following drill ("not running" / "chain did not produce"). With the settle the
  full suite is **11/11 PASS** in a single run.
- **Harness**: G3/G4 asserts are robust to Node's quoting (single quotes);
  `verify_statehash_match` now uses the block hash at a common height as the
  **authoritative** check (`verify_chain_agreement`, alignment-free) and the
  derived-state statehash only as a **warning** (it diverges transiently after a
  restart/partition without being a fork); new **`G9-old-node.sh`** (builds/caches
  the `v2.0.3` image + no-fork invariant).
- **G6 with libfaketime** (`Dockerfile` + `docker-compose.drills-clock-skew.yml` +
  `G6-clock-skew.sh`). `cap_add: [SYS_TIME]` + `date -s` is **not** safe: containers
  share the host kernel clock, so `date -s` would move the **host** clock.
  libfaketime skews only the node process (`LD_PRELOAD`, `FAKETIME=±5s`); the host
  is untouched.

### Topology note

With `NO_DISCOVERY=1` the miners all connect to the **bootstrap** (hub): each node
has **1 peer** (the bootstrap), which has 7 peers. That is the expected behaviour,
not a lack of connectivity. A restart of the **bootstrap only** leaves miners with
0 peers until they reconnect (now guaranteed by the `keepAlive` fix).

## Operator checklist — public testnet launch (copy for each launch)

References: the guide [`doc/public-testnet.md`](../../doc/public-testnet.md), the
drill matrix above, the mainnet runbook
`doc/mainnet-deployment-and-rollback.md`.

### Coordinator — before announcing

- [ ] Tag **frozen and pushed**: `v2.1.0`; on every operator machine
      `git describe --tags` = `v2.1.0`.
- [ ] Testnet config patch written and published **as `git diff src/config.js`**:
      dedicated `originHash`, `block0ts`, fresh `masterPub`/`masterPubLeader`,
      `masterDaoTxs`, `leaderMaxVotes: 8`, `masterLeaderUntil: 0`, Layer S/H active
      at a low height (e.g. 100).
- [ ] Patch re-checked **byte-for-byte** by a second person.
- [ ] Genesis rehearsed on a throwaway machine: `db.dropDatabase()`, **no**
      `genesis.zip`, the chain advances past `#0`.
- [ ] Master private key stored safely; **testnet keys only**.
- [ ] Peer list + bootstrap endpoint (`ws://<ip>:6001`) ready to publish.
- [ ] Launch date/height and checkpoints decided; pinned message written.

### Each operator — before the launch

- [ ] Node.js ≥ 24, MongoDB running, **NTP/chrony active** (`maxDrift` = 200 ms).
- [ ] P2P port (6001) **reachable from the internet**; HTTP port per policy.
- [ ] Fresh **testnet** keypair (`node src/cli.js keypair`); never mainnet keys.
- [ ] `git checkout v2.1.0` + `npm ci`; `git diff src/config.js` **identical** to the coordinator's patch.
- [ ] Clean start: `db.dropDatabase()`, no `genesis.zip`, empty `blocks/`.
- [ ] Env: `HTTP_HOST=0.0.0.0`, `CORS_ORIGIN`, `TRUST_PROXY`, `ADMIN_TOKEN`/`LOG_ADMIN_TOKEN`,
      `PEERS=ws://<bootstrap>:6001`, `NODE_OWNER*`.
- [ ] `NO_DISCOVERY` **not** set (public network); publish your endpoint with
      `profile … '{"node":{"ws":"ws://<ip>:6001"}}'`.

### Launch day — checkpoints

- [ ] `curl /version` → `{"version":"2.1.0"}` **identical on every node** (census).
- [ ] `curl /count` monotonic; `curl /peers` shows peers from independent entities.
- [ ] `grep -c "Different chain id, disconnecting"` = **0**.
- [ ] `grep -c "Hard Fork #13330000"` = **0**.
- [ ] Every operator posts `version` / `count` / `peers` on the channel.

### Drills to run **on the public network** (the reason it exists)

- [ ] **Discovery**: briefly stop the coordinator's bootstrap → do the other nodes
      re-discover and stay on **one** chain? (the local drills do **not** cover this
      path: they run with `NO_DISCOVERY=1`).
- [ ] Leader offline ~100 blocks; clock skew (NTP off on one node); 3/2 partition;
      collision (two `/mineBlock`); all-leaders-down with recovery.
- [ ] After **every** drill: all nodes agree on `count` and block hashes.

### If something breaks

- [ ] **Halt, don't fork**: stop, collect logs, coordinate on the channel.
- [ ] Rollback: stop → previous commit → restore the pre-change Mongo snapshot +
      `blocks.bson`.
