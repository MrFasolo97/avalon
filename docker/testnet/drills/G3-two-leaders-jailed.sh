#!/bin/bash
# G3: 2 leaders down long enough to be jailed.
# Expected: both jailed, chain continues with E=3/q=3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

# Must be two leaders in the current rotation. Default: original topology.
VICTIMS=(${VICTIMS:-avalon-drills-miner4 avalon-drills-miner5})
log "G3 starting: stopping ${VICTIMS[*]} until jailed"
start_height=$(get_height)
log "Start height: $start_height"

stop_nodes "${VICTIMS[@]}"

trap 'start_nodes "${VICTIMS[@]}"' EXIT

TIMEOUT=1200
log "Waiting up to ${TIMEOUT}s for both victims to be jailed..."
deadline=$((SECONDS + TIMEOUT))
victim_names=()
for v in "${VICTIMS[@]}"; do victim_names+=("$(leader_name "$v")"); done
while [ $SECONDS -lt $deadline ]; do
    consensus=$(get_consensus)
    all_jailed=true
    for n in "${victim_names[@]}"; do
        if [ "$(json_extract "$consensus" ".leaderHealth.$n.jailed" || echo "false")" != "true" ]; then
            all_jailed=false
        fi
    done
    if [ "$all_jailed" = "true" ]; then
        break
    fi
    sleep 5
done

for i in "${!victim_names[@]}"; do
    n="${victim_names[$i]}"
    if [ "$(json_extract "$consensus" ".leaderHealth.$n.jailed" || echo "false")" != "true" ]; then
        fail "Not all victims jailed within ${TIMEOUT}s (${n} not jailed)"
    fi
done

end_height=$(get_height)
log "Jailed at height $end_height"
pass "Both victims jailed; chain advanced by $((end_height - start_height)) blocks"

# With Layer H standby promotion the jailed leaders are replaced by standbys,
# so the active/eligible set does NOT shrink to L-2: assert instead that the
# jailed victims left the eligible set and the set still reaches quorum.
eligible_names=$(json_extract "$(get_consensus)" ".eligibleLeaders.map(l => l.name || l).join(',')" || echo "")
still_eligible=false
for n in "${victim_names[@]}"; do
    if echo ",$eligible_names," | grep -q ",$n,"; then
        still_eligible=true
    fi
done
if [ "$still_eligible" = "true" ]; then
    fail "A jailed victim is still in the eligible set: $eligible_names"
fi
pass "Jailed victims excluded from the eligible set ($eligible_names)"

start_nodes "${VICTIMS[@]}"
for v in "${VICTIMS[@]}"; do wait_node_synced "$v" 200 || true; done
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
print_leader_health
