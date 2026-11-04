#!/bin/bash
# G8: force-finalize with asymmetric views.
# Kill a node, let the others advance, then restart it. The restarted node must
# converge via FF_FETCH / recover() without forking.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

VICTIM="avalon-drills-miner5"
start_height=$(get_height)
log "G8 starting at height $start_height"

stop_nodes "$VICTIM"

trap 'start_nodes "$VICTIM"' EXIT

log "Letting majority advance 20 blocks..."
if wait_blocks 20 120; then
    majority_height=$(get_height)
    log "Majority at $majority_height"
else
    fail "Majority did not advance"
fi

log "Restarting $VICTIM"
start_nodes "$VICTIM"

log "Waiting for victim to catch up..."
if wait_height "$majority_height" 120; then
    pass "Asymmetric view resolved; victim caught up"
else
    fail "Victim did not catch up"
fi

sleep 10
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4
print_leader_health
