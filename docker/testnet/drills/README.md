# Layer S/H Drill Scripts

Automation scripts for the G1–G12 matrix of
`doc/consensus-offline-leaders-plan.en.md`.

## Prerequisite

The drills testnet must be running:

```bash
cd docker/testnet
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml up -d --build
```

## Usage

Run a single script:

```bash
cd docker/testnet/drills
bash G1-one-leader-down-60-blocks.sh
```

Or the fast suite:

```bash
bash run-all-drills.sh
```

To also include the long drills (jail, standby promotion):

```bash
bash run-all-drills.sh --long
```

The suite calls `settle_testnet` before every drill (restarts any container left
down and waits for the chain to advance), so an interrupted drill no longer
cascades into the following ones.

## Available scripts

| Script | Drill | Typical duration | Notes |
|--------|-------|------------------|-------|
| `G1-one-leader-down-60-blocks.sh` | G1 | ~2 min | |
| `G2-one-leader-jailed.sh` | G2 | ~10 min | waits for 30 missed turns |
| `G3-two-leaders-jailed.sh` | G3 | ~15 min | |
| `G4-standby-promotion.sh` | G4 | ~12 min | Layer H |
| `G5-network-partition.sh` | G5 | ~3 min | disconnects 2 nodes from the Docker network |
| `G6-clock-skew.sh` | G6 | variable | ±5s via libfaketime; SKIPs if the image lacks `faketime` |
| `G7-equivocation.sh` | G7 | ~1 min | two concurrent `/mineBlock` via docker exec |
| `G8-force-finalize-asymmetric.sh` | G8 | ~2 min | kill + restart a node |
| `G9-old-node.sh` | G9 | ~4 min (first run builds the image) | previous-release (`v2.0.3`) node, no-fork invariant |
| `G10-all-leaders-down.sh` | G10 | ~2 min | deterministic halt |
| `G11-halt-breaker-recovery.sh` | G11 | ~2 min | automatic recovery round |
| `G12-halt-breaker-off.sh` | G12 | ~2 min | requires the testnet started with `docker-compose.drills-halt-breaker-off.yml` |

## Implementation

The drills do not rely on the testnet host ports: they use `docker exec` to call
each container's internal HTTP API on `localhost:3001`. That keeps the scripts
robust even where Docker Compose does not support the `!reset` YAML tag for port
lists.

## Output

Every script prints `[PASS]` or `[FAIL]` and restores the container state in a
`trap EXIT`.

## Fixes and known limits (run 2026-11-03)

Code bugs found while running the drills on `avalon-drills` (now fixed):

* **Every leader auto-jailed (blocking).** The setup's `enable-node` txs tripped the
  heartbeat rule, which marked *every* leader `probation`; the first block each one
  produced re-jailed it (`recordProduced`), the rotation collapsed onto the standbys
  and then onto an empty set → `schedule.shuffle[...] is undefined` → all nodes
  crashed. `heartbeat` now arms `probation` only for an account actually in jail, and
  `recordProduced` closes probation into ACTIVE (design §6.2).
* **Halt breaker could never fire.** `_resolveForceFinalize` zeroed `ffProposals`
  right before calling `runHaltBreaker()`, which therefore always saw
  `0/5 respondents` and could never fire. `ffProposals` is now preserved.

Harness bugs (fixed): G1 checked the statehash of the node it had just stopped; G10
compared the height with the pre-stop one (blocks produced during the stop counted as
"progress"); G2/G3/G4/G11 checked right after the restart, before catch-up (new
`wait_node_synced` helper).

Other code bugs found and fixed:

* **Resume after a total stop.** A node that restarted never tried to produce
  (`minerWorker` was only called from `addBlock`) and, when it did, the "slow
  performance" guard gave up the slot because the head was old. Now: 1) `main.js`
  kicks `minerWorker` at boot; 2) `minerWorker` still produces if the head is old
  (chain stopped); 3) the FF proposal is re-broadcast by the halt breaker on every
  attempt, and only *recent* `respondents` are counted (dead nodes' votes expire) —
  previously `ffProposals` was zeroed and 0 votes were always seen.

**Verified:** G10 now stops the chain with everyone down and **resumes** when the
leaders return. To resume there must be **at least one authorised producer** (the
`head+1` scheduled leader or a recent backup) among the restarted nodes: restarting
the whole set is the safe choice.

G12 (breaker OFF) is framed around **3 leaders down**: with 2 down the adaptive
quorum recovers by itself (`E=3, q=3`), so there is no halt to observe.

`verify_statehash_match` now aligns heights before comparing: on a live chain a naive
read looks like a divergence (one node at `h`, another at `h+1`) — only a mismatch
**at the same height** is real.

**G5 (partition) — resolved.** Resync after the heal failed for three reasons, now
fixed:

1. `keepAlive` considered any socket with matching IP/port connected even if **dead**
   (half-open left by `docker network disconnect`), and threw on a null `_socket` → it
   never reconnected. It now requires `readyState === OPEN` and closes sockets that
   don't answer status probes within 20 s.
2. The peers' `node_status` was a handshake snapshot **never refreshed** and was
   overwritten by the `QUERY_NODE_STATUS` handler → `refresh()`/`recover()` compared
   stale heads and never saw the gap. There is now a periodic refresh (5 s) and
   `node_status` is preserved.
3. `refresh()` only recovered with a gap **> 10** blocks; it now recovers even with a
   small gap if the head is stuck (**stalled**).

Also, `/debug/statehash` no longer includes `possBlocks` (transient gossip that made
healthy nodes look divergent), and `tryNextStep` no longer multiplies timers (it was a
hot loop that blocked the event loop during a stall).

**Status of the drills on the current build (v2.1.0): all of G1–G12 PASS** (G1–G11 in
one `run-all-drills.sh --long` run, G12 with the breaker-off overlay). See
[`../README-drills.md`](../README-drills.md) for the full results and the fixes that
came out of them.
