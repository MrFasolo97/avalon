#!/bin/bash
# Internal runner executed inside the 'avalon-drills' screen session.
# It builds/starts the testnet, waits for readiness, then runs the long drill suite.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$SCRIPT_DIR/.."
LOG_FILE="/tmp/avalon-drills-run-$(date +%Y%m%d-%H%M%S).log"

source "$SCRIPT_DIR/lib.sh"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "=============================================="
echo " Avalon Layer S/H drill suite (screen)"
echo " Started at $(date)"
echo " Log: $LOG_FILE"
echo "=============================================="

cd "$COMPOSE_DIR"

echo ""
echo "[1/4] Building and starting testnet..."
docker compose -p avalon-drills \
    -f docker-compose.yml \
    -f docker-compose.drills.yml up -d --build

echo ""
echo "[2/4] Waiting for bootstrap API and block production..."
deadline=$((SECONDS + 600))
while [ $SECONDS -lt $deadline ]; do
    h=$(get_height)
    if [ "$h" -ge 20 ]; then
        echo "Testnet ready at height $h"
        break
    fi
    echo "  height=$h, waiting..."
    sleep 5
done

h=$(get_height)
if [ "$h" -lt 20 ]; then
    echo "ERROR: testnet did not become ready in time"
    exit 1
fi

# The drills stop specific containers and expect specific leaders to be
# scheduled. That only holds once all 5 real leaders are voted in and the
# master account has left the rotation (masterLeaderUntil in the overlay).
echo ""
echo "[2b/4] Waiting for the leader rotation to be miner1..miner5 (master out)..."
deadline=$((SECONDS + 420))
rotation=""
while [ $SECONDS -lt $deadline ]; do
    rotation=$(json_extract "$(get_consensus)" ".activeLeaders.map(l => l.name || l).join(',')" 2>/dev/null || echo "")
    echo "  activeLeaders=[$rotation]"
    if echo ",$rotation," | grep -q ",miner1," \
        && echo ",$rotation," | grep -q ",miner2," \
        && echo ",$rotation," | grep -q ",miner3," \
        && echo ",$rotation," | grep -q ",miner4," \
        && echo ",$rotation," | grep -q ",miner5,"; then
        break
    fi
    sleep 10
done
if ! echo ",$rotation," | grep -q ",miner5,"; then
    echo "ERROR: leader rotation is [$rotation], expected miner1..miner5"
    exit 1
fi
echo "Leader rotation ready: [$rotation]"

echo ""
echo "[3/4] Running drill suite (long)..."
cd "$SCRIPT_DIR"
bash run-all-drills.sh --long

echo ""
echo "[4/4] Drill suite finished at $(date)"
echo "Log file: $LOG_FILE"
echo "Press Enter to keep this screen session open, or Ctrl+D to close."
read -r
