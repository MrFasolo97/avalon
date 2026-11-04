#!/bin/bash
# G6: clock skew ±5s on two nodes.
# Expected: future blocks are held in pending queue, accepted later, no peer ban.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

VICTIM="avalon-drills-miner5"
start_height=$(get_height)
log "G6 starting at height $start_height"

# Try to skew the victim's clock forward by 5 seconds.
# This requires the container to have CAP_SYS_TIME (usually not available).
if docker exec "$VICTIM" date -s "+5 seconds" >/dev/null 2>&1; then
    log "Skewed $VICTIM clock +5s"
else
    log "SKIP: cannot skew container clock (needs privileged/CAP_SYS_TIME). Run this drill manually with: docker run --privileged ..."
    exit 0
fi

trap 'docker exec "$VICTIM" date -s "-5 seconds" >/dev/null 2>&1 || true' EXIT

log "Waiting 30s to observe pending-block behaviour..."
sleep 30

end_height=$(get_height)
if [ "$end_height" -gt "$start_height" ]; then
    pass "Chain advanced despite clock skew (height $start_height -> $end_height)"
else
    fail "Chain stalled after clock skew"
fi

# Reset clock and verify convergence
docker exec "$VICTIM" date -s "-5 seconds" >/dev/null 2>&1 || true
sleep 10
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4
print_leader_health
