#!/usr/bin/env bash
# jail-restart.sh — restart a leader container and optionally send a heartbeat
set -euo pipefail
NODE=${1:-miner2}
echo "[jail-restart] starting avalon-jail-$NODE"
docker start "avalon-jail-$NODE" >/dev/null
if [ "${2:-}" = "heartbeat" ]; then
    sleep 3
    echo "[jail-restart] sending heartbeat from $NODE"
    docker exec "avalon-jail-$NODE" node -e "
        const fetch = require('node-fetch');
        // TODO: implement via CLI or curl once heartbeat endpoint is exposed
        console.log('heartbeat placeholder for', '$NODE');
    " || true
fi
