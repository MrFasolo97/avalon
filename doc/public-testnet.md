# Avalon Public Testnet — Multi-Operator Guide

**Status:** pre-launch (draft for coordinator review)
**Target release:** **`v2.0.3`** on the dedicated branch **`testnet/public`** — the *no-economy* line; hard fork `#13330000` is **not** included
**Audience:** independent operators (entities that run their own node on their own infrastructure, with their own keys)
**Companions:** [`migration-runbook-no-econs.en.md`](./migration-runbook-no-econs.en.md), [`mainnet-deployment-and-rollback.md`](./mainnet-deployment-and-rollback.md), [`testnet-migration-test.en.md`](./testnet-migration-test.en.md) (local S4 rehearsal), [`docker/testnet/README.md`](../docker/testnet/README.md)

---

## 0. TL;DR

A public testnet is a **separate chain** that runs the same certified code as the upcoming mainnet migration, but on a fresh genesis and with **different, testnet-only** values for the fields that define a chain. Every independent entity runs a real node on its own machine, over the public internet, and they must agree on **two things**:

1. the **same commit** — the `testnet/public` branch, and
2. the **same testnet config**, already frozen in that branch (chain id, master key, fork height).

Miss either one and the entities end up on **different chains** that silently ignore each other. Everything else (ports, peers, own keys) is per-operator.

The testnet exists to rehearse, with real independent operators, exactly what the mainnet flag day will do: multi-node P2P, leader rotation, force-finalization, halt recovery, the new HTTP security defaults, and Node 24.

---

## 1. Scope — what this testnet is (and is not)

| | |
|---|---|
| **Runs** | `testnet/public` (certified `v2.0.3` + frozen testnet config), Node.js ≥ 24, no economy fork (`#13330000` absent) |
| **Chain** | fresh, isolated chain; block `#0` is a fixed genesis; the master account (default `dtube`) holds the testnet supply |
| **Exercises** | multi-operator P2P, leader election/rotation, **force-finalization** (activated early), halt recovery, `CORS_ORIGIN`/`TRUST_PROXY`/rate limiting/auth, `/version` census |
| **Does NOT contain** | any mainnet balances, contents or history; any real value |
| **Must never reach** | mainnet peers, or any other chain (enforced by a **distinct `originHash`**, §4) |

Owners and keys on the testnet are **throwaway**. Never reuse a mainnet key, and never point a testnet node at a mainnet MongoDB.

---

## 2. Roles

**Coordinator** (one entity, decided before launch):
- fixes and publishes the testnet config (§4), the peer list, and the launch height/date;
- holds the **master private key** and bootstraps the chain (§5);
- keeps an authoritative clock reference (NTP) and announces fork heights and upgrade windows.

**Operator** (each independent entity):
- runs one or more nodes on its own infrastructure and network;
- owns its **own leader keypair**, separate from mainnet;
- reports `version` / `count` / `peers` on the shared channel at the agreed checkpoints.

Coordination happens on one channel (Discord `DTube Chain → #leader-candidates`) plus a pinned launch message. Anything that changes consensus must be announced *before* it takes effect — same rule as the mainnet runbook.

---

## 3. Prerequisites (per operator)

- **Node.js ≥ 24** (`node -v`); `engines` requires it and `main.js` enforces it.
- **MongoDB** running locally (the docker dev net uses `mongo:6.0.2`).
- **NTP / chrony** active — block timestamps have a hard `maxDrift` of 200 ms.
- **Disk / RAM** for the chain DB and a `blocks.bson` directory.
- **Open ports**: HTTP (default `3001`) and P2P (default `6001`). To be reachable by other entities, the P2P port must be reachable from the internet; publish `ws://your-ip:6001` in your profile so discovery can find you.
- **A fresh node keypair**: `node src/cli.js keypair > my-testnet-key.json`.
- Docker + Compose v2 (optional) and `jq`/`curl` for the verification steps.

---

## 4. The frozen testnet configuration (already in this branch)

The chain identity lives in `src/config.js`, and on this branch those values are **already frozen** — operators do **not** generate or patch anything. Because `#0` is a fixed genesis block whose hash is taken verbatim from `config.originHash`, these fields **are** the chain id: any difference between two nodes means two chains.

| Field | Frozen value | Why |
|---|---|---|
| `originHash` | `12968579b1537d511e834dd4b6095f8ff4e1144f823b13e8b6af83de03e52a2f` | **isolates the testnet.** The P2P handshake drops any peer whose `origin_block !== config.originHash` (`src/p2p.js`), so testnet and mainnet can never peer. Block `#0` inherits this hash. |
| `block0ts` | `1767225600000` | genesis timestamp / bw-vt growth base (identical everywhere) |
| `masterName` | `dtube` | master account name |
| `masterPub` / `masterPubLeader` | `2AV8nB9KTcHcQQJQ8BGvaUDXX5Yr3fU3hTFhoqMZkExrz` | testnet master keypair. `mongo.insertMasterAccount()` builds the master from these; the **private** key is held by the coordinator only (not in the repo). |
| `masterDaoTxs` | widened | lets the master create accounts, transfer, enable and vote on the fresh chain |
| `forceFinalize` | `true` from block **100** | the point of the testnet: exercise the anti-fork safety net early (mainnet enables it only at `13 325 000`) |

Verify that your tree matches — this must print the values above, and nothing for `13330000`:

```bash
git diff v2.0.3 -- src/config.js          # the testnet-only delta (compare with the coordinator's)
grep -n "originHash\|block0ts\|masterPub" src/config.js
grep -n "13330000\|rewardPoolYearlyRate\|initialSupplyBlock" src/config.js   # must print nothing
```

> The branch **is** the contract: whoever runs `testnet/public` at the published commit has the exact config. If your `src/config.js` differs in any of these fields, you are on a different chain — stop and ask.

---

## 5. Bootstrap (coordinator, once)

Goal: produce block `#0` and the first blocks, then hand every operator an account.

```bash
# 1. Fresh code on the coordinator machine — the testnet branch (config already frozen)
git fetch --all --tags && git checkout testnet/public
npm ci

# 2. Confirm the frozen testnet config is present (§4)
git diff v2.0.3 -- src/config.js

# 3. Start from a clean DB and NO genesis.zip:
#    with no genesis.zip, initGenesis() inserts the master account + block #0
mongosh avalon --eval "db.dropDatabase()"        # or docker: drop the mongo volume
rm -rf ./genesis ./genesis.zip ./blocks/*

# 4. Configure keys + ports + auth, then start
export HTTP_HOST=0.0.0.0 CORS_ORIGIN='*' ADMIN_TOKEN=<token> LOG_ADMIN_TOKEN=<token>
export NODE_OWNER=dtube NODE_OWNER_PUB=2AV8nB9KTcHcQQJQ8BGvaUDXX5Yr3fU3hTFhoqMZkExrz
export NODE_OWNER_PRIV=<coordinator's testnet private key — kept offline, never committed>
./scripts/start.sh

# 5. Kick production until the chain moves on its own
for i in $(seq 1 20); do curl -sf localhost:3001/mineBlock; sleep 3; done
curl -s localhost:3001/count          # must advance past #0
```

Then create the operator accounts and fund them (master key):

```bash
node src/cli.js account   <OPERATOR_PUB> <operator_name> -K <masterPriv> -M dtube
node src/cli.js transfer  <operator_name> 100000          -K <masterPriv> -M dtube
```

Alternatively (fast path for late joiners) the coordinator can publish a **database snapshot** of the bootstrapped state instead of asking everyone to replay from `#0`. A snapshot is not required for correctness here — unlike mainnet, a testnet node needs **no** `genesis.zip`, because block `#0` is deterministic and every node recomputes the same one from the shared config.

Once the chain runs, publish on the shared channel: the **commit** of `testnet/public`, the **bootstrap peer** (`ws://<coordinator-ip>:6001`) and the launch height.

---

## 6. Join (each operator)

```bash
git clone https://github.com/dtube/avalon.git && cd avalon
git fetch --all --tags && git checkout testnet/public
npm ci

# The frozen testnet config ships with the branch — verify it matches the published one (§4)
git diff v2.0.3 -- src/config.js

# Clean slate: no mainnet data, no leftover genesis.zip
mongosh avalon --eval "db.dropDatabase()"
rm -rf ./genesis ./genesis.zip ./blocks/*
mkdir -p blocks && export BLOCKS_DIR=$(pwd)/blocks
```

Set the environment (§7), then start `./scripts/start.sh`. The node creates the master account, the deterministic block `#0`, connects to the bootstrap peer and syncs via catch-up. Confirm with `/count`, `/peers` and `/schedule`.

To be discoverable, publish your P2P endpoint in your profile (optional but recommended for a public net):

```bash
node src/cli.js profile -K <operator_key> -M <operator_name> '{"node":{"ws":"ws://<your-ip>:6001"}}'
```

---

## 7. Environment variables that matter

The `v2.0.x` line adds secure-by-default behaviour and **can break clients or lock out peers** if unset. Set at least these (the `docker/docker-compose.yml` shows a working set):

| Variable | Default | Testnet value | Why |
|---|---|---|---|
| `HTTP_HOST` | `127.0.0.1` | `0.0.0.0` | reachable from outside / other services |
| `CORS_ORIGIN` | `false` (no CORS) | `*` (or the client origin) | browsers get nothing cross-origin otherwise |
| `TRUST_PROXY` | off (`X-Forwarded-For` ignored) | `1` | only behind a reverse proxy; **not** set = rate-limit bucket shared by all clients |
| `ADMIN_TOKEN` / `LOG_ADMIN_TOKEN` | unset → privileged endpoints accept plain requests | a real token | `/mineBlock`, `/recover`, `/debug`, `/logs` are otherwise open |
| `HTTP_PORT` / `P2P_PORT` | `3001` / `6001` | your choice | expose the P2P port to the internet |
| `PEERS` | empty | `ws://<bootstrap>:6001` (+ others) | initial connectivity |
| `MAX_PEERS` | `15` | `50`+ if you are a public node | discovery fan-in |
| `NODE_OWNER` / `NODE_OWNER_PUB` / `NODE_OWNER_PRIV` | — | your testnet key | required to produce / vote |
| `NO_DISCOVERY` | off | leave off for a public net | discovery is what makes it a network (the *local* docker net sets `NO_DISCOVERY=1`) |
| `LEADER_STATS` | off | `1` (optional) | per-leader produced/missed counters |

Notes:
- The global HTTP rate limit is **50 req/s per IP**; `/transact` has its own **5 req/s** limiter; the JSON body cap is **1 MB**. Test batch flows against these before declaring the testnet healthy.
- **Never commit a `start.sh` containing `NODE_OWNER_PRIV`.** Put keys in an untracked `.env` or export them at start.

---

## 8. Becoming a leader

Leader eligibility is by votes (`node_appr`). On a testnet with a handful of entities, coordinate a sensible leader set (`leaders: 5` in config):

```bash
# 1. generate a leader key (per operator)
node src/cli.js keypair > leader-key.json

# 2. associate it on-chain (signed by the account master key, or an authorised key)
node src/cli.js enable-node <LEADER_PUB> -M <operator_name> -K <account_key>

# 3. vote (the master can vote for everyone on the testnet)
node src/cli.js vote-leader <operator_name> -M dtube -K <masterPriv>
```

If fewer than `leaders` accounts are eligible, `minerSchedule()` pads the shuffle with repeats, so a small testnet still produces blocks. Keep the leader set small and agreed; a public P2P net with too few leaders is slow to notice liveness problems.

---

## 9. Verification checklist (must pass on every node)

```bash
curl -s localhost:3001/version          # {"version":"2.0.3"} — IDENTICAL on every node
curl -s localhost:3001/count            # head advances monotonically
curl -s localhost:3001/peers            # peers from independent entities
curl -s localhost:3001/schedule         # leader shuffle is present and consistent

# continuity
H=$(curl -s localhost:3001/count | tr -d '"')
curl -s localhost:3001/block/$H         | grep -o '"phash":"[^"]*"'
curl -s localhost:3001/block/$((H-1))   | grep -o '"hash":"[^"]*"'   # must match

# no economy fork, ever
grep -c "Hard Fork #13330000" /var/log/avalon.log     # expected: 0
grep "Hard Fork #" /var/log/avalon.log | tail -3      # 241600, then forceFinalize at the chosen height
```

**Determinism check** (the reason a testnet is worth running before the flag day): on a control node, rebuild from genesis on the same commit and confirm it reaches the **same head and the same block hashes** as a running node:

```bash
REBUILD_STATE=1 ./scripts/start.sh
```

**Force-finalization drill** (only after the `forceFinalize` height): trigger two near-simultaneous blocks on two different miners and confirm the network converges:

```bash
curl http://<minerA>:3001/mineBlock & curl http://<minerB>:3001/mineBlock &
# then watch:
watch -n1 'curl -s http://<bootstrap>:3001/count'
grep -i "force\|collision" /var/log/avalon.log
```

---

## 10. Failure drills worth running

The testnet is only useful if it is pushed into the failure modes the mainnet runbook cares about:

| Drill | Do | Expected |
|---|---|---|
| Leader offline | stop one leader node for ~100 blocks | chain continues via the fallback ladder; no halt |
| Clock skew | shift one node's clock ±5 s | blocks delayed then accepted; no peer ban, no divergence |
| Partition | cut network between two groups | majority keeps producing; minority resyncs by catch-up (`recover()`), no divergent height |
| Collision | two `/mineBlock` on different miners (§9) | deterministic winner, chain resumes |
| Halt recovery | stop enough leaders to stall | `DRY_RUN=1 ./scripts/auto_resolve_halt.sh` first, then coordinate (see the mainnet runbook §"Emergency") |
| Old node | run one node on the previous commit | it must lag, never fork; upgrade it |

Assert that all nodes agree on `count` and block hashes after each drill. A drill that "passes" while two nodes disagree is a failed drill.

---

## 11. Upgrade, tag changes and rollback

- **Everyone runs the same commit.** A new tag on the testnet is a coordinated event: announce it, agree on an upgrade height/window, and upgrade all nodes together. Mixing commits can change validators and split the chain (mainnet runbook, R2).
- **Rollback** = stop, `git checkout` the previous commit, restore the pre-change MongoDB snapshot and `blocks.bson`. As on mainnet, once the new commit has validated blocks, going back means truncating or restoring — keep snapshots before every change.
- **Do not add `config.history` entries** (or bump fork heights) without a coordinated, announced height; heights in `history` are immutable once passed.

---

## 12. House rules

- **Testnet keys only.** Every key here is disposable; never sign anything with a mainnet key on the testnet.
- **One channel, one source of truth.** The coordinator's pinned message holds the tag, the config patch, the peer list and the current launch/height state.
- **Report on checkpoints.** Each operator posts `version`, `count`, `peers` at the agreed checkpoints and after every drill.
- **Halt, don't fork.** If the network splits, stop and coordinate — do not truncate or restart a divergent node on your own.
- **Isolate.** If you ever see a peer you cannot account for, check `origin_block` in your logs (`Different chain id, disconnecting`); a wrong `originHash` is the usual cause.

---

## Appendix A — quick reference

```bash
# chain id / isolation
grep -n "originHash\|block0ts\|masterPub\|masterName" src/config.js
grep -n "13330000" src/config.js                       # must be empty

# what a node is doing
curl -s localhost:3001/version
curl -s localhost:3001/count
curl -s localhost:3001/peers
curl -s localhost:3001/schedule

# healthy startup / no misconfig
grep -iE "error|fatal" /var/log/avalon.log | tail -20
grep -c "Different chain id, disconnecting" /var/log/avalon.log

# CLI used in this guide
node src/cli.js keypair > leader-key.json
node src/cli.js account <pub> <name>          -K <masterPriv> -M dtube
node src/cli.js transfer <name> 100000        -K <masterPriv> -M dtube
node src/cli.js enable-node <leaderPub> -M <name> -K <accountKey>
node src/cli.js vote-leader <name> -M dtube -K <masterPriv>
node src/cli.js profile -K <key> -M <name> '{"node":{"ws":"ws://<ip>:6001"}}'
```

## Appendix B — difference from the local dev net

`docker/testnet/` (3 miners + bootstrap on one host, `NO_DISCOVERY=1`, shared Mongo, dev keys) is a **single-machine smoke test**. This guide is the **multi-operator public** counterpart: separate infrastructure, separate Mongo, separate keys, real P2P and discovery, and an isolated chain id. Reuse the dev net to rehearse the exact commands; use this guide to run the real thing.
