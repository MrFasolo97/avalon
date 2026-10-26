#!/usr/bin/env bash
# jail-kill.sh — stop a leader container to simulate death
set -euo pipefail
NODE=${1:-miner2}
echo "[jail-kill] stopping avalon-jail-$NODE"
docker stop "avalon-jail-$NODE" >/dev/null
