#!/bin/bash
# G13: a leader restarting from a stale head must not create a competing block.
#
# Regression for the height-269 fork found during G11->G9: the scheduled leader
# was killed, a backup filled its slot (skips:['miner4']), and the leader came
# back ~10 s later with a stale view and produced a SECOND block at the same
# height. The network split 4-4 and the forward-only recovery could not heal it.
#
# Expected after the fix: the restarted node waits for in-flight candidates
# (pending_head in NODE_STATUS) and for the stale-head grace period, catches up,
# and every node agrees on one canonical chain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

AGREEMENT_ATTEMPTS=240
VICTIM="avalon-drills-miner4"
VICTIM_NAME="miner4"

settle_testnet 180 || fail "testnet was not advancing before G13"
require_running

start_height=$(get_height)
log "G13 starting at height $start_height"

log "Killing $VICTIM (scheduled leader candidate)"
kill_nodes "$VICTIM"
trap 'docker start "$VICTIM" >/dev/null 2>&1 || true' EXIT

# Wait until a backup has filled a slot by skipping the victim. That proves the
# victim was scheduled (and absent) at that height — exactly the fork trigger.
slot_height=0
deadline=$((SECONDS + 150))
while [ $SECONDS -lt $deadline ]; do
    h=$(get_height)
    for n in $(seq $((start_height + 1)) "$h"); do
        body=$(api_get "$BOOTSTRAP" "/block/$n")
        if echo "$body" | grep -q '"skips"[^]]*"'"$VICTIM_NAME"'"'; then
            slot_height=$n
            break 2
        fi
    done
    sleep 2
done
if [ "$slot_height" -eq 0 ]; then
    fail "no backup block with skips=['$VICTIM_NAME'] was produced while the leader was down"
fi
pass "Backup filled the slot at #$slot_height while $VICTIM was down"

# Bring the stale leader back immediately, while the just-produced block may
# still be an in-flight candidate on peers rather than a finalised head.
log "Restarting $VICTIM from its stale view"
docker start "$VICTIM" >/dev/null 2>&1 || fail "could not restart $VICTIM"
wait_node_synced "$VICTIM" 200 || true

# The whole network must be advancing again, then every node must agree.
settle_testnet 240 || true
verify_chain_agreement "$BOOTSTRAP" "${LEADERS[@]}" "${STANDBYS[@]}"

# Explicitly check the two heights around the backup slot: a stale-head fork
# would show up as a different hash at slot_height or at slot_height+1.
for h in "$slot_height" "$((slot_height + 1))"; do
    first=""
    for c in "$BOOTSTRAP" "${LEADERS[@]}" "${STANDBYS[@]}"; do
        hash=$(api_get "$c" "/block/$h" | grep -oP '"hash":\s*"\K[0-9a-f]+' | head -1 || echo "")
        [ -z "$hash" ] && fail "node $c has no block #$h"
        if [ -z "$first" ]; then first="$hash"
        elif [ "$first" != "$hash" ]; then
            fail "fork at #$h: $c has ${hash:0:12}, expected ${first:0:12}"
        fi
    done
done
pass "No competing block at #$slot_height or #$((slot_height + 1))"

print_leader_health
pass "G13 complete: stale leader restart did not fork the chain"
