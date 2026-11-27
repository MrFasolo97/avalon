#!/bin/bash
# G14: slow leader -> clean view-change with single-vote enabled.
#
# Prerequisite: the drills testnet must run with the S1' single-vote overlay:
#   docker compose -p avalon-drills \
#     -f docker-compose.yml -f docker-compose.drills.yml \
#     -f docker-compose.drills-single-vote.yml up -d
#
# The scheduled leader of the next height is stopped; the remaining leaders
# must form a precommit quorum for a backup candidate, unlock cleanly using the
# NEW-block QC (R3b) and finalize it through the normal COMMIT quorum. The
# chain must keep advancing and every node must converge. Neither
# force-finalize nor the halt-breaker may fire.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_running
settle_testnet || fail "testnet not advancing before G14"
clear_all_delays

consensus=$(get_consensus)
single_vote=$(json_extract "$consensus" '.flags.singleVote')
[ "$single_vote" = "true" ] || fail "G14 requires singleVote=true (start the testnet with docker-compose.drills-single-vote.yml)"

next_height=$(json_extract "$consensus" '.nextHeight')
shuffle=$(json_extract "$consensus" '.schedule.shuffle.map(s => s.name || s).join(",")')
leaders_count=$(json_extract "$consensus" '.schedule.shuffle.length')
[ -n "$next_height" ] && [ -n "$shuffle" ] && [ "$leaders_count" -gt 0 ] \
    || fail "cannot read the leader schedule from /consensus"

idx=$(( (next_height - 1) % leaders_count ))
scheduled=$(echo "$shuffle" | cut -d, -f "$((idx + 1))")
[ -n "$scheduled" ] || fail "no scheduled leader for height $next_height"
scheduled_container=$(leader_container "$scheduled")
log "G14: slow leader is $scheduled ($scheduled_container) for height $next_height"

trap 'start_nodes "$scheduled_container" >/dev/null 2>&1 || true; clear_all_delays' EXIT

# Docker's --since uses the daemon clock, while the app logger prints the
# container clock. During drills those clocks drift by minutes, so --since can
# either miss fresh lines or replay old ones. Mark the log length instead and
# inspect only lines appended after this point.
declare -A log_mark
for c in "${ALL_MINERS[@]}" "$BOOTSTRAP"; do
    log_mark[$c]=$(docker logs "$c" 2>&1 | wc -l | tr -d '[:space:]')
done

start_height=$(get_height)
stop_nodes "$scheduled_container"

wait_blocks 3 150 || fail "chain did not advance past the slow leader at height $start_height"
end_height=$(get_height)
log "G14: advanced $start_height -> $end_height without the scheduled leader"

start_nodes "$scheduled_container"
wait_node_synced "$scheduled_container" 180 || fail "$scheduled_container did not catch up"
verify_statehash_match "$BOOTSTRAP" "${LEADERS[@]}" "$scheduled_container"

# At least one finalized block must have been produced by a different leader.
view_changed=0
for (( hh = start_height + 1; hh <= end_height; hh++ )); do
    miner=$(json_extract "$(api_get "$BOOTSTRAP" "/block/$hh")" '.miner')
    if [ -n "$miner" ] && [ "$miner" != "$scheduled" ]; then
        view_changed=1
    fi
done
[ "$view_changed" -eq 1 ] || fail "no view-change winner observed between $start_height and $end_height"

# No unilateral recovery: only log lines appended since the mark are inspected.
for c in "${ALL_MINERS[@]}" "$BOOTSTRAP"; do
    first=$((log_mark[$c] + 1))
    bad=$(docker logs "$c" 2>&1 | tail -n "+$first" \
        | grep -Ei 'Force finalizing block|FF backoff exhausted|trying halt breaker|Halt breaker firing|Halt breaker fired' || true)
    if [ -n "$bad" ]; then
        log "$c recovery log: $bad"
        fail "force-finalize or halt-breaker fired on $c during G14"
    fi
done

pass "G14: slow-leader view-change finalized cleanly with singleVote=true (no FF/halt-breaker)"
print_leader_health
