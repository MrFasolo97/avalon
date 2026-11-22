#!/bin/bash
# G7: equivocation under a slow leader and uneven network delays.
#
# miner3 is slowed to 800ms P2P delay (slow leader), miner2 gets 150ms. While
# those delays are active two leaders are forced to propose at the same height.
# Expected: deterministic rank picks one block, no fork, and every node ends up
# with the EXACT same derived state hash (no manual recovery).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running
settle_testnet || log "settle: continuing despite warning"
clear_all_delays

SLOW_LEADER="avalon-drills-miner3"
apply_delay "$SLOW_LEADER" 800
apply_delay avalon-drills-miner2 150

log "Letting the chain advance with asymmetric delays..."
wait_blocks 3 90 || fail "chain did not advance under delays"

start_height=$(get_height)
log "G7 equivocation: forcing /mineBlock on miner2 and miner3 at height $((start_height + 1))"

(docker exec avalon-drills-miner2 curl -sf --max-time 10 "http://localhost:3001/mineBlock" >/dev/null 2>&1) &
(docker exec "$SLOW_LEADER" curl -sf --max-time 10 "http://localhost:3001/mineBlock" >/dev/null 2>&1) &
wait

if wait_blocks 12 150; then
    end_height=$(get_height)
    pass "Chain settled after equivocation (height $start_height -> $end_height)"
else
    clear_all_delays
    fail "Chain did not settle after equivocation"
fi

clear_all_delays
sleep 5

NODES=("$BOOTSTRAP" "${LEADERS[@]}")
for c in "${NODES[@]}"; do
    wait_node_synced "$c" 180 || fail "$c did not converge to the common height"
done

require_exact_statehash "${NODES[@]}"
print_leader_health
