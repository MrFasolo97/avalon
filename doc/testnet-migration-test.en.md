# Testnet dry run — migrating from `new_net` to the new code

**Type**: test procedure · **Companion**: `doc/migration-runbook-no-econs.en.md` (step **S4**)

**Goal**: rehearse the `new_net` → `feat/auto-force-finalize` upgrade on a local
testnet, on the same data, and verify chain continuity, determinism, the new
code paths and the anti-fork safety net. Nothing here touches mainnet — this is
the rehearsal that must pass before step **S5** (the mainnet cutover).

## 0. Pass criteria

| # | Check | Pass criterion |
|---|-------|----------------|
| 1 | Continuity | after the switch the chain resumes from the same head; new blocks link to it via `phash` |
| 2 | Version | `/version` is identical on **every** node and equals the release version |
| 3 | No economy | `Hard Fork #13330000` never appears in the logs |
| 4 | State preserved | the balance canaries (`s4alice`/`s4bob`/`s4carol`) keep their balance across the switch |
| 5 | New paths | post-migration activity works, including the new create-account bandwidth check |
| 6 | Force finalization | two concurrent blocks are resolved deterministically, with no split |
| 7 | Negative parity | `comment-edit` is still rejected (disabled by `txLimits`) |
| 8 | Determinism | a chain rebuilt with the new code matches the `new_net` block hashes |

If any check fails, stop and treat it as a mainnet blocker (**R2** in the
runbook: a validator change that rejects an already-produced block means fork
or impossible rebuild).

## 1. Topology, and how the testnet maps to the migration

| Service | HTTP (host) | P2P (host) | Container |
|---------|-------------|------------|-----------|
| bootstrap | `:3101` | `:6101` | `avalon-testnet-bootstrap` |
| miner1 | `:3102` | `:6102` | `avalon-testnet-miner1` |
| miner2 | `:3103` | `:6103` | `avalon-testnet-miner2` |
| miner3 | `:3104` | `:6104` | `avalon-testnet-miner3` |
| mongodb | `:37017` | — | `avalon-testnet-mongodb` |

The compose file bind-mounts `../../src` and `./scripts` into the containers,
so **the nodes run whatever is checked out in the working tree**. Switching code
version is therefore a `git checkout` followed by a restart — not an image
rebuild. `node_modules` are baked into the image, so a change to `package.json`
(for example the `sharp` bump) *does* require `docker compose build`.

The migration uses the overlay `docker-compose.migrate.yml`, which replaces the
bootstrap command only:

```yaml
command: ["bash", "-c", "node /avalon/scripts/s4-patch.js && exec node --stack-size=65500 src/main"]
```

The reason: the normal `testnet-genesis.sh` **drops the database on every
start**, which would destroy chain continuity. The migration must restart the
node on the existing data instead, applying the testnet-only config patch
(`s4-patch.js`) first.

## 2. Running the commands

All `docker compose` commands below run from `docker/testnet`, because the
compose file uses relative paths (`../../src`, `./scripts`). `git` commands run
from the repository root.

Throughout, `<release ref>` is the release candidate — the `v2.0.x` tag once it
is cut, or the branch `feat/auto-force-finalize` before tagging.

A small helper is used to read a value out of the JSON responses (no `jq`
needed, `node` may not be on the host either):

```bash
# count: GET /count -> {"count":N}; prints 0 if the node is unreachable
count() { local n; n=$(curl -sf "http://localhost:$1/count" | sed -n 's/.*"count":\([0-9]*\).*/\1/p'); echo "${n:-0}"; }
```

## 3. Phase A — baseline on `new_net`

```bash
git checkout new_net
cd docker/testnet
docker compose build
docker compose up -d

# wait for the chain to advance
until [ "$(count 3101)" -gt 50 ]; do sleep 2; done

# freeze the reference head
HEAD_A=$(count 3101)
echo "baseline head: $HEAD_A"
```

Record the reference block hashes. A block does not store its own hash in a
directly readable field: it is stored as the **`phash` of the next block**, so
the hash of height `h` is `GET /block/h+1` → `phash`.

```bash
: > /tmp/hashes-new_net.txt
for h in $(seq $((HEAD_A - 100)) $HEAD_A); do
  ph=$(curl -sf "http://localhost:3101/block/$((h + 1))" | sed -n 's/.*"phash":"\([^"]*\)".*/\1/p')
  printf '%s %s\n' "$h" "$ph" >> /tmp/hashes-new_net.txt
done
wc -l /tmp/hashes-new_net.txt      # ~101 lines
```

Record the per-node version (all four nodes, so the comparison later is exact):

```bash
for p in 3101 3102 3103 3104; do echo "$p $(curl -s localhost:$p/version)"; done
```

Generate pre-migration activity (accounts, transfers, posts, votes, a profile):

```bash
docker compose run --rm setup node /avalon/scripts/s4-fake-txs.js
```

This also creates the balance canaries `s4alice`/`s4bob`/`s4carol`
(balance `20000`), which are checked again after the switch.

## 4. Phase B — switch to the release candidate

```bash
cd ../..
git checkout <release ref>
cd docker/testnet
docker compose build        # only needed if dependencies changed (e.g. sharp)
docker compose -f docker-compose.yml -f docker-compose.migrate.yml up -d \
    --force-recreate --no-deps bootstrap miner1 miner2 miner3
```

`--force-recreate` is required because the running processes still hold the old
code in memory; `--no-deps` keeps the one-shot `setup` service (and mongodb)
from being re-run mid-migration. The overlay applies `s4-patch.js`, which
injects the testnet-only patch:

- `masterDaoTxs` widened (so the master can fund miners),
- `forceFinalize: true` **at block 100**, so the safety net is active right away
  on a fresh testnet instead of at height 13,325,000.

**This patch is testnet-only and must never be shipped** — the same reason the
runbook warns that the `100: { forceFinalize: true }` entry must not appear in
the released `src/config.js`.

## 5. Phase C — verify

Continuity — the chain resumes and extends the same head:

```bash
count 3101                                   # must be > $HEAD_A
curl -s "http://localhost:3101/block/$((HEAD_A + 1))" \
  | sed -n 's/.*"phash":"\([^"]*\)".*/\1/p'  # must equal the hash of $HEAD_A
```

Version — identical everywhere, and equal to the release version
(`package.json` → currently `2.0.3`):

```bash
for p in 3101 3102 3103 3104; do echo "$p $(curl -s localhost:$p/version)"; done
```

No economy fork — must print `0`, and stays `0` forever:

```bash
docker compose logs --no-log-prefix | grep -c "Hard Fork #13330000"
```

Force-finalization fork — must appear once the testnet passes block 100:

```bash
docker compose logs --no-log-prefix | grep "Hard Fork #" | tail -3
```

State preserved and new paths exercised:

```bash
docker compose run --rm setup node /avalon/scripts/s4-fake-txs.js --post
```

This prints a roster with each account's `balance`/`bw`/`keys`, and exercises
the **new** create-account path (which added a bandwidth check). The canaries
`s4alice`/`s4bob`/`s4carol` must still show `balance=20000`.

## 6. Force-finalization drill

Two leaders mine a block at the same height. In two terminals, almost
simultaneously:

```bash
curl -s http://localhost:3102/mineBlock   # miner1
curl -s http://localhost:3103/mineBlock   # miner2
```

Both blocks land in `possBlocks[]`; no leader reaches 2/3, and after the
backoff the deterministic tie-break (lowest timestamp, then lowest hash) picks
one winner. The chain must keep advancing, with no split:

```bash
# the head must stay monotonic
for i in $(seq 1 30); do echo "$(date) $(count 3101)"; sleep 2; done

docker compose logs --no-log-prefix | grep -i "force\|collision" | tail
```

## 7. Determinism / re-validation of the historical chain (S4 point 3)

The validator changes (`validate/json.js`, `float.js`, `integer.js`,
`string.js`, create-account bandwidth, block-size bounds) are **not
height-gated**: they take effect as soon as the new code runs. The requirement
is that the new code still accepts — and re-derives the same hashes for — every
block the old code produced.

Note the mechanics: a block hash is computed from the block's stored fields
**including its timestamp**, and the timestamp comes from the wall clock
(`chain.prepareBlock()` → `new Date().getTime()`). Two independently mined
chains can therefore never be compared hash-for-hash — the comparison has to be
made on the *same* blocks. So this is a re-validation, not a re-mine.

Force a node to re-validate the whole history with the new code: drop its local
database and let it sync again from the bootstrap.

```bash
# each miner has its own database on the shared mongodb service
docker exec avalon-testnet-mongodb mongosh avalon_miner3 --quiet --eval 'db.dropDatabase()'
docker compose -f docker-compose.yml -f docker-compose.migrate.yml up -d \
    --force-recreate --no-deps miner3
```

Let it catch up, then compare its head hash with the bootstrap:

```bash
until [ "$(count 3104)" -ge "$(count 3101)" ]; do sleep 5; done
H=$(count 3101)
a=$(curl -sf "http://localhost:3101/block/$((H + 1))" | sed -n 's/.*"phash":"\([^"]*\)".*/\1/p')
b=$(curl -sf "http://localhost:3104/block/$((H + 1))" | sed -n 's/.*"phash":"\([^"]*\)".*/\1/p')
echo "$a"; echo "$b"; [ "$a" = "$b" ] && echo IDENTICAL
```

If the new code rejects any historical block, the re-syncing node stalls before
reaching the head — that is the **R2** failure mode, and a mainnet blocker.

## 8. Teardown / rollback

```bash
cd docker/testnet
docker compose down -v            # remove containers, volumes, testnet keys
git checkout new_net              # restore the baseline code state
```

## 9. Pitfalls

- **Run compose from `docker/testnet`.** The bind-mount paths are relative; from
  the repository root the mounts resolve to the wrong place.
- **`--force-recreate` is not optional.** Editing `src` on disk does not change a
  running node; it must be restarted to load the new code.
- **`setup` and `testnet-genesis.sh` are one-shot.** `testnet-genesis.sh` drops
  the database, and `setup` re-creates the miner keys — neither must run during
  the migration, hence the overlay and `--no-deps`.
- **The testnet-only patch must not be committed.** `s4-patch.js` edits
  `src/config.js` at runtime; if you ever ran it against your working tree,
  revert `src/config.js` before committing (check with `git diff src/config.js`).
- **`/count` returns `{"count":N}`**, and a block's own hash is read as the
  `phash` of the block above it.

---

*Related*: `docker/testnet/README.md` (testnet setup and the force-finalization
drill), `doc/migration-runbook-no-econs.en.md` §S4 and §S8.
