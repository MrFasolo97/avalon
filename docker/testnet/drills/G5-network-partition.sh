#!/bin/bash
# G5: 3/2 network partition for ~100 blocks.
# Expected: majority (3) finalises; minority (2) resyncs after reconnect.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

MAJORITY=(avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3)
MINORITY=(avalon-drills-miner4 avalon-drills-miner5)

start_height=$(get_height)
log "G5 starting at height $start_height"
log "Isolating minority: ${MINORITY[*]}"

NETWORK=$(docker inspect "${MAJORITY[0]}" --format '{{range $n, $v := .NetworkSettings.Networks}}{{printf "%s\n" $n}}{{end}}' | head -1)
if [ -z "$NETWORK" ]; then
    fail "Could not detect Docker network"
fi
log "Detected network: $NETWORK"

for c in "${MINORITY[@]}"; do
    docker network disconnect "$NETWORK" "$c" >/dev/null
    log "Disconnected $c from $NETWORK"
done

trap 'for c in ${MINORITY[*]}; do docker network connect "$NETWORK" "$c" >/dev/null 2>&1 || true; done' EXIT

log "Waiting 150s for majority to advance (adaptive quorum drops the 2 isolated leaders)..."
sleep 150

majority_height=$(get_height)
log "Majority side height: $majority_height"
if [ "$majority_height" -le "$start_height" ]; then
    fail "Majority did not advance while minority was partitioned"
fi
pass "Majority advanced by $((majority_height - start_height)) blocks"

log "Reconnecting minority..."
for c in "${MINORITY[@]}"; do
    docker network connect "$NETWORK" "$c" >/dev/null
    log "Reconnected $c"
done

# Wait for the MINORITY nodes themselves to reach the majority height. (The old
# check read the bootstrap's own height, which was already >= the target, so it
# always "passed" while the minority was still behind.)
log "Waiting for the minority to catch up..."
caught=1
for c in "${MINORITY[@]}"; do
    wait_node_synced "$c" 180 || caught=0
done
if [ "$caught" = "1" ]; then
    pass "Minority caught up to the majority"
else
    fail "Minority did not catch up"
fi

# Verify no fork after resync (all 5 leaders + the bootstrap observer)
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
print_leader_health
