# Monitoring & alerts — `scripts/avalon-watch.js`

An **external**, optional watcher that polls a node's HTTP API and posts to a
Discord **webhook** when something is wrong. It is deliberately out-of-process:

- **no change to `src/`, no consensus impact** (it only reads the public API);
- **add/remove freely** — run it as a sidecar / systemd unit / container, or
  delete the file to disable it;
- works with the API the node already exposes: `/count`, `/peers`, `/consensus`
  and, when watching several nodes, `/debug/statehash`.

A webhook is **outbound only**. For inbound commands (e.g. `!status`) you would
need a Discord **bot** (token + gateway) — out of scope here.

## Quick start

```bash
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…' \
NODE_NAME='avalon-leader1' \
AVALON_URL='http://localhost:3001' \
node scripts/avalon-watch.js
```

Test without sending anything:

```bash
DRY_RUN=1 NODE_NAME=test AVALON_URL=http://localhost:3001 node scripts/avalon-watch.js
```

## What it alerts on

| Condition | Trigger | Emoji |
|---|---|---|
| **Node unreachable** | the API stops answering | 🔴 |
| **Chain halted** | head unchanged for `HALT_MS` | 🔴 |
| **Isolated** | fewer than `MIN_PEERS` for `ISOLATED_MS` | 🔴 |
| **Divergence** | two watched nodes disagree on head / statehash | 🔴 |
| **Quorum degraded** | `eligibleLeaders < activeLeaders` | 🟠 |
| **possBlocks backlog** | `possBlocksCount > POSSBLOCKS_MAX` (a height not converging) | 🟠 |
| **Leader(s) jailed** | any leader with `jailed: true` | 🟠 |

Each condition fires once on the OK→BAD transition, repeats at most every
`ALERT_COOLDOWN_MS`, and sends a **🟢 recovered** message on BAD→OK — so you get
a "chain halted" and a "chain advancing again", not a stream of noise.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `AVALON_URL` | `http://localhost:3001` | base URL of the node to watch |
| `AVALON_WATCH_URLS` | — | extra node URLs (comma-separated) for the **divergence** check |
| `DISCORD_WEBHOOK_URL` | — | the webhook (required to actually send) |
| `WATCH_INTERVAL_MS` | `15000` | poll interval |
| `HALT_MS` | `120000` | head stale this long ⇒ HALT (2 min ≈ 40 blocks at 3 s; avoids false positives on a slow block) |
| `MIN_PEERS` | `1` | peers below this ⇒ isolated |
| `ISOLATED_MS` | `30000` | isolated this long ⇒ alert |
| `POSSBLOCKS_MAX` | `20` | possBlocks backlog threshold |
| `ALERT_COOLDOWN_MS` | `300000` | min gap between repeats |
| `NODE_NAME` | hostname | label in the messages |
| `DRY_RUN` | `0` | `1` = log instead of posting |
| `WATCH_EVENTS` | `1` | also forward structured events from `/events` (`0` disables) |
| `EVENT_LEVELS` | `warn,error` | which event levels to forward |
| `EVENT_TYPES` | (all) | optional allow-list of event types to forward |

`/transact` is limited to 5 req/s and the global API to 50 req/s per IP, so keep
`WATCH_INTERVAL_MS` well above the number of requests per poll (a handful).

## Prometheus `/metrics`

The node also exposes a native Prometheus endpoint (text exposition `0.0.4`) at
`GET /metrics`, so you can scrape it into Prometheus / VictoriaMetrics and alert
from there instead of (or in addition to) the Discord watcher:

| Metric | Meaning |
|---|---|
| `avalon_height` | head height (`-1` = unknown) |
| `avalon_peers` | connected P2P peers |
| `avalon_active_leaders` / `avalon_eligible_leaders` | active vs quorum-eligible set size |
| `avalon_quorum_threshold` | votes required to finalise |
| `avalon_poss_blocks` | candidate-block backlog |
| `avalon_queue_size` | buffered consensus/P2P messages |
| `avalon_recovering` | 1 while catching up from a peer |
| `avalon_flag{name=…}` | effective consensus flags (1/0): `force_finalize`, `skip_recording`, `skip_strict`, `halt_breaker`, `standby_enabled`, `canonical_leader_order`, `single_vote` |
| `avalon_leader_jailed{leader=…}` / `_streak` / `_produced_total` / `_missed_total` | per-leader health |
| `avalon_version_info{version=…}` | always 1; join label |
| `avalon_uptime_seconds` | process uptime |

```yaml
# prometheus.yml
scrape_configs:
  - job_name: avalon
    metrics_path: /metrics
    static_configs:
      - targets: ['leader1:3001', 'leader2:3001', 'leader3:3001']
```

Suggested alert rules (Prometheus): `avalon_height` unchanged for 2 min (halt),
`avalon_peers < 1` (isolated), `avalon_poss_blocks` high, `avalon_eligible_leaders
< avalon_active_leaders` (quorum degraded), `avalon_leader_jailed == 1`.

## Structured events — `GET /events`

The node keeps a bounded in-process ring buffer of structured events (default
2000, `EVENT_BUFFER_MAX`), recorded at the moments that matter during an incident:

| `type` | When |
|---|---|
| `halt-breaker-fired` | the halt breaker ran a recovery round |
| `force-finalize` | a block was force-finalised from the local candidate set |
| `block-collision` / `collision-timeout` | two or more candidates at one height |
| `leader-jailed` / `leader-rejailed` / `leader-unjailed` | jail state transitions |
| `recover-start` / `recover-done` / `recover-giveup` | catching up from a peer |

`GET /events?since=<seq>&limit=<n>&type=a,b` returns `{ head, events }`; pass the
last `seq` you have as `since` to receive only new events.

The same data is exported in `/metrics` as `avalon_events_head`,
`avalon_event_total{type=…}` and `avalon_last_event_timestamp_seconds{type=…}` —
so an alert can fire on a **rare** event without polling, e.g.:

```yaml
- alert: AvalonHaltBreakerFired
  expr: increase(avalon_event_total{type="halt-breaker-fired"}[5m]) > 0
  annotations: { summary: "halt breaker fired (a halt was auto-recovered)" }
- alert: AvalonLeaderJailed
  expr: increase(avalon_event_total{type="leader-jailed"}[5m]) > 0
```

This closes the "self-healed halt in ~21 s" gap that a head-staleness threshold
misses — the event fires even when the chain resumed before `HALT_MS`.

The Discord watcher (`scripts/avalon-watch.js`) **consumes `/events` directly**: it
polls with `since=<last-seq>`, so each event is posted once, and forwards the ones
whose level is in `EVENT_LEVELS` (`warn,error` by default). On the first poll — or
after the node restarts and its ring buffer resets — it learns the head and does
**not** replay history. Set `EVENT_TYPES=halt-breaker-fired,leader-jailed` to
forward only specific event types, or `WATCH_EVENTS=0` to disable.

## Deployment

**systemd** (per node):

```ini
# /etc/systemd/system/avalon-watch.service
[Unit]
Description=Avalon watcher → Discord
After=network.target

[Service]
WorkingDirectory=/opt/avalon
Environment=DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
Environment=NODE_NAME=avalon-leader1
Environment=AVALON_URL=http://localhost:3001
# add AVALON_WATCH_URLS=… to also check cross-node divergence
ExecStart=/usr/bin/node scripts/avalon-watch.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Docker sidecar** (same host):

```bash
docker run -d --name avalon-watch --restart unless-stopped \
  --network host \
  -e DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…' \
  -e NODE_NAME=avalon-leader1 \
  -e AVALON_URL=http://localhost:3001 \
  -v /opt/avalon/scripts/avalon-watch.js:/watch.js:ro \
  node:24 node /watch.js
```

Or with `pm2`/`screen`/`nohup` like any other sidecar.

## Limits / next steps

- **Per-node**: each operator runs one watcher for their node. Point
  `AVALON_WATCH_URLS` at the other public nodes to also catch **divergence**.
- **Outbound only**: no Discord commands. A bot (inbound) would be a separate
  component.
- **No consensus view**: it alerts on symptoms (halt, isolation, backlog). It does
  not (and cannot) inspect vote internals — that is what `/consensus` is for.
- This watcher is the lightweight half of the "production observability" gap: for
  a full setup, feed the same `/consensus` + `/debug/statehash` metrics into
  Prometheus/Grafana and alert from there.
