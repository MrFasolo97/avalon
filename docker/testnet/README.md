# Avalon Testnet — Force Finalization Test

A multi-node testnet to exercise the **force finalization** mechanism when
concurrent blocks land at the same height.

## Requirements

- Docker + Docker Compose v2

## Start

```bash
cd docker/testnet

# Build the images
docker compose build

# Start all nodes
docker compose up -d

# Follow the logs
docker compose logs -f
```

Automatic startup:
1. **bootstrap** — creates the network from scratch (genesis, block 0, mines the first blocks)
2. **setup** — generates 3 miner keys, creates the accounts, transfers tokens, enables the nodes, votes the leaders
3. **miner1..3** — sync with bootstrap and start mining

## Architecture

| Service | HTTP (host) | P2P (host) | Account |
|---------|-------------|------------|---------|
| bootstrap | `:3101` | `:6101` | dtube (master) |
| miner1 | `:3102` | `:6102` | miner1 |
| miner2 | `:3103` | `:6103` | miner2 |
| miner3 | `:3104` | `:6104` | miner3 |

All nodes are on the same Docker network and discover each other via
`PEERS=ws://bootstrap:6001`.

## Exercising Force Finalization

### Scenario: concurrent blocks

To simulate a conflict (two leaders mine different blocks at the same height):

```bash
# In two different terminals, run these almost simultaneously:
curl http://localhost:3102/mineBlock   # miner1 forces a block
curl http://localhost:3103/mineBlock   # miner2 forces a block
```

If the two `/mineBlock` calls fire within the same tiny interval, both miners
produce a valid block for the same height N. The network's nodes insert both into
`possBlocks[]` and vote. If neither reaches 2/3, after ~27 seconds (5 leaders × 3s
+ 2 rounds × 3s + margin) **force finalization** kicks in: every node
deterministically picks the winner (lowest timestamp → lowest hash) and finalises
it, unblocking the chain.

### Verification

```bash
# Watch the chain height
watch -n 1 'curl -s http://localhost:3101/count'

# See the force finalization log
docker compose logs bootstrap | grep -i "force\|collision"

# After a conflict, check the chain keeps advancing
while true; do
  h=$(curl -s http://localhost:3101/count)
  echo "Block #$h  $(date)"
  sleep 2
done
```

### Stop everything

```bash
docker compose down -v
```

## Config

The main environment variables are in `docker-compose.yml`. The generated keys are
saved in a shared `testnet_config` volume read by every miner.

The admin APIs (`/mineBlock`, `/recover`, `/debug`, `/logs`) are **fail-closed**
without a token. That is why the testnet compose sets `ADMIN_ALLOW_ANONYMOUS=1` on
bootstrap and the miners: so the mining kickstart and the force-finalization drill
work with the bare `curl`s above. It is a **local-only** exception: on
mainnet/public testnets a real `ADMIN_TOKEN` must be configured.
