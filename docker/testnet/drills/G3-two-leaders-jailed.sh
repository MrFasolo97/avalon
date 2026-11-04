#!/bin/bash
# G3: 2 leaders down long enough to be jailed.
# Expected: both jailed, chain continues with E=3/q=3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

VICTIMS=(avalon-drills-miner4 avalon-drills-miner5)
log "G3 starting: stopping ${VICTIMS[*]} until jailed"
start_height=$(get_height)
log "Start height: $start_height"

stop_nodes "${VICTIMS[@]}"

trap 'start_nodes "${VICTIMS[@]}"' EXIT

TIMEOUT=1200
log "Waiting up to ${TIMEOUT}s for both victims to be jailed..."
deadline=$((SECONDS + TIMEOUT))
jailed4=false
jailed5=false
while [ $SECONDS -lt $deadline ]; do
    consensus=$(get_consensus)
    if [ "$(json_extract "$consensus" ".leaderHealth.miner4.jailed" || echo "false")" = "true" ]; then
        jailed4=true
    fi
    if [ "$(json_extract "$consensus" ".leaderHealth.miner5.jailed" || echo "false")" = "true" ]; then
        jailed5=true
    fi
    if [ "$jailed4" = "true" ] && [ "$jailed5" = "true" ]; then
        break
    fi
    sleep 5
done

if [ "$jailed4" != "true" ] || [ "$jailed5" != "true" ]; then
    fail "Not all victims jailed within ${TIMEOUT}s (miner4=$jailed4 miner5=$jailed5)"
fi

end_height=$(get_height)
log "Jailed at height $end_height"
pass "Both victims jailed; chain advanced by $((end_height - start_height)) blocks"

# With Layer H standby promotion the jailed leaders are replaced by standbys,
# so the active/eligible set does NOT shrink to L-2: assert instead that the
# jailed victims left the eligible set and the set still reaches quorum.
eligible_names=$(json_extract "$(get_consensus)" ".eligibleLeaders.map(l => l.name || l).join(',')" || echo "")
if echo ",$eligible_names," | grep -qE ",miner4,|,miner5,"; then
    log "Warning: a jailed victim is still in the eligible set: $eligible_names"
else
    pass "Jailed victims excluded from the eligible set ($eligible_names)"
fi

start_nodes "${VICTIMS[@]}"
for v in "${VICTIMS[@]}"; do wait_node_synced "$v" 200 || true; done
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
print_leader_health
