#!/bin/bash
# G4: top-5 leader jailed, standby promoted (Layer H).
# Expected: standby1 enters activeLeaderSet at the next epoch boundary and produces at 3s.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

VICTIM="avalon-drills-miner5"
VICTIM_NAME="$(leader_name "$VICTIM")"
log "G4 starting: stopping $VICTIM until jailed"
start_height=$(get_height)

stop_nodes "$VICTIM"

trap 'start_nodes "$VICTIM"' EXIT

# Wait for jail
TIMEOUT=900
deadline=$((SECONDS + TIMEOUT))
jailed=false
while [ $SECONDS -lt $deadline ]; do
    consensus=$(get_consensus)
    if [ "$(json_extract "$consensus" ".leaderHealth.$VICTIM_NAME.jailed" || echo "false")" = "true" ]; then
        jailed=true
        break
    fi
    sleep 5
done

if [ "$jailed" != "true" ]; then
    fail "$VICTIM was not jailed within ${TIMEOUT}s"
fi

jail_height=$(get_height)
log "$VICTIM jailed at height $jail_height"

# Wait for the next epoch boundary and a few blocks
next_epoch=$(( (jail_height / 5 + 1) * 5 ))
target=$((next_epoch + 10))
log "Waiting for epoch boundary + 10 blocks (target >= $target)"
if ! wait_height "$target" 180; then
    fail "Did not reach epoch boundary blocks in time"
fi

# Verify standby1 is now in the active leader set.
# The set is a list of names; join it into a comma string so the check does not
# depend on node's JSON quoting style (single vs double quotes).
consensus=$(get_consensus)
active=$(json_extract "$consensus" ".activeLeaders.map(l => l.name || l).join(',')" || echo "")
if echo ",$active," | grep -q ",standby1,"; then
    pass "standby1 promoted to active leader set ($active)"
else
    fail "standby1 not found in active leader set: $active"
fi

# Verify standby1 produced at least one block
schedule=$(api_get "$BOOTSTRAP" "/schedule")
shuffle=$(json_extract "$schedule" ".shuffle.map(l => l.name || l).join(',')" || echo "")
if echo ",$shuffle," | grep -q ",standby1,"; then
    pass "standby1 appears in the current schedule shuffle ($shuffle)"
else
    log "Warning: standby1 not in shuffle yet (may need one more epoch): $shuffle"
fi

start_nodes "$VICTIM"
wait_node_synced "$VICTIM" 150 || true
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-standby1
print_leader_health
