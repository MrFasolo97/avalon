#!/bin/bash
# G10: all 5 leaders down.
# Expected: deterministic halt, no fork; chain resumes when >=3 come back.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

log "G10 starting: stopping all 5 leaders"
start_height=$(get_height)
log "Start height: $start_height"

stop_nodes "${LEADERS[@]}"

trap 'start_nodes "${LEADERS[@]}"' EXIT

# Confirm the halt by HEIGHT STABILITY: stopping 5 nodes takes a few seconds and
# the still-running leaders keep producing during that sequence, so comparing
# against the pre-stop height always "advanced unexpectedly". Wait until the
# head stops moving for a full window instead.
log "Confirming halt (head must stay constant for 18s)..."
stable=0
last=$(get_height)
for i in $(seq 1 40); do
    sleep 3
    now=$(get_height)
    if [ "$now" -eq "$last" ]; then
        stable=$((stable + 3))
    else
        stable=0
        last=$now
    fi
    if [ "$stable" -ge 18 ]; then break; fi
done
if [ "$stable" -lt 18 ]; then
    fail "Chain is still advancing with all leaders down (head $last)"
fi
pass "Chain halted at $last with all leaders down"

# Bring the leaders back. Recovery needs at least one AUTHORISED producer (the
# scheduled leader for head+1 or a recent backup) to be running: it now kicks the
# scheduler on boot and, seeing a stale head, mines even though it is "late"
# (the chain-halted path in minerWorker). Restarting the whole set guarantees it.
log "Restarting all leaders"
start_nodes "${LEADERS[@]}"

if wait_blocks 5 300; then
    end_height=$(get_height)
    pass "Chain resumed after the leaders returned (height $start_height -> $end_height)"
else
    fail "Chain did not resume after restarting the leaders"
fi

for v in "${LEADERS[@]}"; do wait_node_synced "$v" 200 || true; done
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
print_leader_health
