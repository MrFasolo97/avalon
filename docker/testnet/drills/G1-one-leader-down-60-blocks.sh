#!/bin/bash
# G1: 1 leader down for ~60 blocks
# Expected: chain continues, skips are recorded, no jail.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

TARGET_BLOCKS=60
TIMEOUT=480
VICTIM="avalon-drills-miner5"

log "G1 starting: stopping $VICTIM for ~$TARGET_BLOCKS blocks"
start_height=$(get_height)
log "Start height: $start_height"

stop_nodes "$VICTIM"

trap 'start_nodes "$VICTIM"' EXIT

if wait_blocks "$TARGET_BLOCKS" "$TIMEOUT"; then
    end_height=$(get_height)
    log "End height: $end_height"
    pass "Chain produced $((end_height - start_height)) blocks while $VICTIM was down"
else
    fail "Chain did not produce $TARGET_BLOCKS blocks within ${TIMEOUT}s"
fi

# Verify the victim is not jailed (streak < 30)
consensus=$(get_consensus)
streak=$(json_extract "$consensus" ".leaderHealth.miner5.streak" || echo "")
if [ -n "$streak" ] && [ "$streak" -ge 30 ]; then
    fail "Unexpected: miner5 jailed (streak=$streak)"
fi

print_leader_health

# Bring the victim back and let it catch up before the cross-node determinism
# check — verifying while it is stopped always failed on "could not fetch".
start_nodes "$VICTIM"
wait_node_synced "$VICTIM" 150 || fail "$VICTIM did not catch up after restart"
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
