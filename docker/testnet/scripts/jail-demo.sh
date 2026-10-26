#!/bin/bash
# jail-demo.sh — drives the offline-leader (jail) prototype demo on the isolated testnet.
#
#   ./jail-demo.sh baseline     # rotation, ladder, quorum on every node
#   ./jail-demo.sh kill         # stop the leader miner2 (the "offline leader")
#   ./jail-demo.sh observe [n]  # poll height / skips / quorum / jail for n rounds
#   ./jail-demo.sh skips        # last blocks carrying skips[] (chain evidence)
#   ./jail-demo.sh wake         # restart miner2 and send the ENABLE_NODE heartbeat
#   ./jail-demo.sh all          # baseline, kill, observe, wake, skips
#
# Requires: docker access to the avalon-jail compose project.
set -uo pipefail

BOOT="${BOOT:-http://127.0.0.1:3201}"
COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -p avalon-jail -f $COMPOSE_DIR/docker-compose.jail.yml"
MONGO=avalon-jail-mongodb
SETUP=avalon-jail-setup
VICTIM=avalon-jail-miner2
NODES=(3201 3202 3203 3204 3205)

health() { # $1 = port
    curl -s --max-time 5 "http://127.0.0.1:$1/leaderhealth"
}

brief() { # $1 = port
    health "$1" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  (no answer)"); sys.exit(0)
q = d["quorum"]
print("  h=%s tip=%s skips=%s shuffle=%s standby=%s ladder=%s"
      % (d["height"], d["tip"]["miner"], d["tip"]["skips"], d["schedule"]["shuffle"],
         d["schedule"]["standby"], d["ladder"]))
print("  E=%s q=%s eligible=%s jailed=%s streaks=%s breaker=%s"
      % (q["E"], q["q"], q["eligible"], d["jailed"], d["streaks"], d["breaker"]))
'
}

cmd_baseline() {
    echo "=== baseline: one line per node ==="
    for p in "${NODES[@]}"; do
        echo "[$p]"
        brief "$p"
    done
}

cmd_kill() {
    echo "=== stopping the leader $VICTIM ($(date +%H:%M:%S)) ==="
    docker stop "$VICTIM" >/dev/null 2>&1
    echo "stopped"
}

cmd_observe() {
    local rounds="${1:-10}"
    echo "=== observing $rounds rounds ==="
    for i in $(seq 1 "$rounds"); do
        echo "--- $(date +%H:%M:%S) round $i ---"
        brief 3201
        docker logs --since 20s avalon-jail-bootstrap 2>&1 \
            | grep -iE "haltBreaker|missedBy|block .* got finalized" | tail -2
        sleep 6
    done
}

cmd_skips() {
    echo "=== blocks attesting skips (chain evidence) ==="
    docker exec "$MONGO" mongosh avalon --quiet --eval '
        db.blocks.find({skips: {$exists: true}}, {_id: 1, miner: 1, missedBy: 1, skips: 1})
            .sort({_id: -1}).limit(25).toArray().forEach(b =>
                print(b._id + "  miner=" + b.miner + "  skips=" + JSON.stringify(b.skips)))
    '
}

cmd_wake() {
    echo "=== restarting $VICTIM and sending the ENABLE_NODE heartbeat ($(date +%H:%M:%S)) ==="
    docker start "$VICTIM" >/dev/null 2>&1
    echo "waiting for its API..."
    for i in $(seq 1 60); do
        if curl -sf --max-time 2 http://127.0.0.1:3203/count >/dev/null 2>&1; then
            echo "miner2 API up"
            break
        fi
        sleep 2
    done
    # heartbeat = the existing ENABLE_NODE tx (type 18) re-sent with the current key:
    # idempotent, no fee, clears the jail immediately (plan §7)
    docker exec "$SETUP" node -e '
const fs = require("fs")
const { execSync } = require("child_process")
const k = require("/avalon/config/testnet-keys/miner2.json")
const out = execSync(`node src/cli.js enable-node ${k.pub} -A http://bootstrap:3001 -K ${k.priv} -M miner2`, {cwd: "/avalon"}).toString().trim()
console.log("heartbeat:", out || "(no output)")
'
    echo "heartbeat sent, waiting for the next epoch to see miner2 back in the rotation"
}

case "${1:-all}" in
    baseline) cmd_baseline ;;
    kill) cmd_kill ;;
    observe) shift; cmd_observe "${1:-10}" ;;
    skips) cmd_skips ;;
    wake) cmd_wake ;;
    all)
        cmd_baseline
        cmd_kill
        cmd_observe 8
        cmd_skips
        cmd_wake
        ;;
    *) echo "unknown command: ${1:-}"; exit 1 ;;
esac
