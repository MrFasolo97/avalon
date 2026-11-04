#!/bin/bash
# G2: 1 leader down long enough to be jailed (30 consecutive missed turns).
# Expected: jailed after ~150 blocks, chain continues with E=4/q=4.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

VICTIM="avalon-drills-miner5"
VICTIM_NAME="$(leader_name "$VICTIM")"
log "G2 starting: stopping $VICTIM until jailed"
start_height=$(get_height)
log "Start height: $start_height"

stop_nodes "$VICTIM"

trap 'start_nodes "$VICTIM"' EXIT

# Wait up to 15 minutes for jail
TIMEOUT=900
log "Waiting up to ${TIMEOUT}s for $VICTIM to be jailed..."
deadline=$((SECONDS + TIMEOUT))
jailed=false
while [ $SECONDS -lt $deadline ]; do
    consensus=$(get_consensus)
    is_jailed=$(json_extract "$consensus" ".leaderHealth.$VICTIM_NAME.jailed" || echo "false")
    if [ "$is_jailed" = "true" ]; then
        jailed=true
        break
    fi
    sleep 5
done

if [ "$jailed" != "true" ]; then
    fail "$VICTIM was not jailed within ${TIMEOUT}s"
fi

end_height=$(get_height)
log "Jailed at height $end_height"
pass "$VICTIM jailed; chain advanced by $((end_height - start_height)) blocks"

# Verify eligible set dropped to 4
eligible=$(json_extract "$(get_consensus)" ".eligibleLeaders.length" || echo "")
if [ -n "$eligible" ] && [ "$eligible" -eq 4 ]; then
    pass "Eligible set reduced to 4 as expected"
else
    log "Warning: eligible set is $eligible (expected 4)"
fi

start_nodes "$VICTIM"
wait_node_synced "$VICTIM" 150 || true
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
print_leader_health
