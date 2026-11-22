#!/bin/bash
# G8: force-finalize with asymmetric views under uneven network delays.
#
# Each of the 5 leaders gets a different P2P delay, one leader is stopped so the
# rest of the quorum advances without it, then it rejoins. Expected: FF_FETCH /
# recover() converge it to the same block and the same derived state hash as
# every other node, with no manual intervention.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running
settle_testnet || fail "testnet was not healthy before G8"

VICTIM="avalon-drills-miner5"

# Always remove delays and bring the victim back even if the drill fails.
trap 'start_nodes "$VICTIM" 2>/dev/null || true; clear_all_delays' EXIT

start_height=$(get_height)
log "G8 starting at height $start_height"
log "Injecting uneven delays: miner1=0ms miner2=150ms miner3=350ms miner4=650ms miner5=1000ms"

apply_delay avalon-drills-miner1 0
apply_delay avalon-drills-miner2 150
apply_delay avalon-drills-miner3 350
apply_delay avalon-drills-miner4 650
apply_delay "$VICTIM" 1000

stop_nodes "$VICTIM"

log "Letting majority advance 20 blocks..."
if wait_blocks 20 150; then
    majority_height=$(get_height)
    log "Majority at $majority_height"
else
    fail "Majority did not advance"
fi

log "Restarting $VICTIM (still delayed)"
start_nodes "$VICTIM"
if wait_node_synced "$VICTIM" 180; then
    pass "Asymmetric view resolved; victim caught up"
else
    fail "Victim did not catch up"
fi

clear_all_delays
wait_blocks 5 90 || fail "chain did not settle after delays were removed"

# STRICT convergence across the full 5-leader set plus bootstrap.
require_exact_statehash \
    avalon-drills-bootstrap \
    avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 \
    avalon-drills-miner4 avalon-drills-miner5

print_leader_health
