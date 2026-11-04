#!/bin/bash
# G7: equivocation — force two leaders to mine different blocks at the same height.
# Expected: deterministic rank picks one block, no fork, chain continues.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running

start_height=$(get_height)
log "G7 starting at height $start_height"
log "Triggering /mineBlock on miner2 and miner3 concurrently"

(docker exec avalon-drills-miner2 curl -sf --max-time 5 "http://localhost:3001/mineBlock" >/dev/null 2>&1) &
(docker exec avalon-drills-miner3 curl -sf --max-time 5 "http://localhost:3001/mineBlock" >/dev/null 2>&1) &
wait

log "Waiting for chain to settle..."
if wait_blocks 10 120; then
    end_height=$(get_height)
    pass "Chain settled after equivocation (height $start_height -> $end_height)"
else
    fail "Chain did not settle after equivocation"
fi

# Check that no fork occurred across the first 5 nodes
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
print_leader_health
