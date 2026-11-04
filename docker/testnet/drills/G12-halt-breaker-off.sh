#!/bin/bash
# G12: 3 leaders killed with HALT_BREAKER=0.
# Expected: deterministic halt, then restart one node resumes the chain.
#
# This script assumes the testnet was launched with:
#   -f docker-compose.drills-halt-breaker-off.yml
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# The recreate with the breaker-off overlay restarts every node; right after
# that the rotation is briefly just the master (catch-up), which would trip
# require_running. Wait for the miner set to come back first.
log "waiting for the rotation to settle after the recreate..."
deadline=$((SECONDS + 120))
while [ $SECONDS -lt $deadline ]; do
    active=$(json_extract "$(get_consensus)" ".activeLeaders.map(l => l.name || l).join(',')" 2>/dev/null || echo "")
    if [ -n "$active" ] && ! echo "$active" | grep -q "dtube"; then break; fi
    sleep 3
done

require_running

# Verify breaker is disabled
flags=$(api_get "$BOOTSTRAP" "/consensus")
if [ -n "$flags" ]; then
    hb=$(json_extract "$flags" ".flags.haltBreaker" || echo "true")
    if [ "$hb" != "false" ]; then
        fail "haltBreaker flag is not false. Launch the testnet with docker-compose.drills-halt-breaker-off.yml"
    fi
fi

# THREE leaders down. Two deaths are NOT enough to halt: the adaptive quorum
# (E drops to 3 via the skip attestation) lets the three survivors finalise, so
# 2-down recovers by itself. With three down only two remain, no block can be
# finalised to record the absences (E stays 5, q stays 4) and the chain halts
# deterministically — which is what the breaker-off path must show.
VICTIMS=(avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5)
log "G12 starting: killing ${VICTIMS[*]}"
start_height=$(get_height)
log "Start height: $start_height"

kill_nodes "${VICTIMS[@]}"

trap 'start_nodes "${VICTIMS[@]}"' EXIT

# Confirm the halt by height stability (allow for in-flight blocks).
log "Confirming halt (head must stay constant for 18s)..."
stable=0
last=$(get_height)
for i in $(seq 1 40); do
    sleep 3
    now=$(get_height)
    if [ "$now" -eq "$last" ]; then stable=$((stable + 3)); else stable=0; last=$now; fi
    if [ "$stable" -ge 18 ]; then break; fi
done
if [ "$stable" -lt 18 ]; then
    fail "Chain is still advancing with 3 leaders down and the breaker off (head $last)"
fi
pass "Chain halted at $last as expected"

# Bring the whole set back: the produced-but-unfinalised block is committed and
# the chain resumes (a partial restart only works if it includes an authorised
# producer — the scheduled leader or a recent backup).
log "Restarting all leaders to resume"
start_nodes "${LEADERS[@]}"

if wait_blocks 5 180; then
    end_height=$(get_height)
    pass "Chain resumed after the leaders returned (height $start_height -> $end_height)"
else
    fail "Chain did not resume after restarting the leaders"
fi

for v in "${LEADERS[@]}"; do wait_node_synced "$v" 200 || true; done
verify_statehash_match avalon-drills-bootstrap avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5
print_leader_health
