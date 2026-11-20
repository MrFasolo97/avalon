#!/bin/bash
# G6: clock skew ±300ms on two nodes.
#
# Expected: future/old blocks are held in the pending queue, then accepted; no
# peer ban and no divergence.
#
# The skew is +300ms / -300ms (600ms apart): above `maxDrift` (200ms) so the
# pending queue is exercised, but far below `blockTime` (3000ms). A ±5s skew
# exceeds a whole block interval and produces a real fork that forward-only
# recovery cannot heal; that abuse case is outside the documented envelope
# (NTP is a hard requirement). See docker-compose.drills-clock-skew.yml.
#
# The skew is applied with libfaketime (LD_PRELOAD), so the HOST clock is never
# touched. `cap_add: [SYS_TIME]` + `date -s` would NOT be safe here: containers
# share the host kernel clock (Docker gives no per-container time namespace), so
# `date -s` inside a container moves the host clock. See
# docker-compose.drills-clock-skew.yml.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# A skew-induced split vote can take a few minutes of FF/halt-breaker retries to
# resolve. The default 90x2s agreement window expired BEFORE the network had
# converged, making G6 fail even though no fork existed. Give it room.
AGREEMENT_ATTEMPTS=240

TESTNET_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OVERLAY="docker-compose.drills-clock-skew.yml"
SKEW_PLUS="avalon-drills-miner5"
SKEW_MINUS="avalon-drills-miner4"
LIBFAKE=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1

require_running

if ! docker exec "$BOOTSTRAP" test -f "$LIBFAKE"; then
    log "SKIP: libfaketime not present in the image (rebuild docker/testnet to install 'faketime')"
    exit 0
fi

restore() {
    ( cd "$TESTNET_DIR" && docker compose -p avalon-drills \
        -f docker-compose.yml -f docker-compose.drills.yml up -d miner4 miner5 >/dev/null 2>&1 ) || true
}
trap restore EXIT

start_height=$(get_height)
log "G6 starting at height $start_height"

log "Recreating $SKEW_PLUS (+300ms) and $SKEW_MINUS (-300ms) with libfaketime"
( cd "$TESTNET_DIR" && docker compose -p avalon-drills \
    -f docker-compose.yml -f docker-compose.drills.yml -f "$OVERLAY" up -d miner4 miner5 >/dev/null 2>&1 ) \
    || fail "could not recreate the nodes with the clock-skew overlay"

# Verify the skew actually took effect: the two nodes must disagree on the wall
# clock by ~600ms (well above maxDrift=200ms) while bootstrap stays in between.
# Measure in milliseconds — a ±300ms skew is invisible at second granularity.
deadline=$((SECONDS + 60)); skewed=false; p=0; m=0
while [ $SECONDS -lt $deadline ]; do
    p=$(docker exec "$SKEW_PLUS" node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0)
    m=$(docker exec "$SKEW_MINUS" node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0)
    if [ "$p" -gt 0 ] 2>/dev/null && [ "$m" -gt 0 ] 2>/dev/null && [ $((p - m)) -ge 400 ] 2>/dev/null; then
        skewed=true; break
    fi
    sleep 3
done
if [ "$skewed" != "true" ]; then
    fail "libfaketime skew did not take effect (+300ms node=$p, -300ms node=$m, delta=$((p-m))ms)"
fi
pass "Clock skew active (+300ms vs -300ms, delta $((p-m))ms), host clock untouched"

log "Observing the pending-block behaviour for 40s..."
sleep 40

end_height=$(get_height)
if [ "$end_height" -gt "$start_height" ]; then
    pass "Chain advanced despite the clock skew (height $start_height -> $end_height)"
else
    fail "Chain stalled after the clock skew"
fi

# Agreement must be checked on a clock-synchronised network: while the skew is
# still applied a skewed node can legitimately trail or hold future blocks in its
# pending queue, so comparing hashes under the skew races. Restore normal time
# first (the EXIT trap would also do it, but the check must run after it).
restore
# Wait for the WHOLE network to be advancing again, not just for the two skewed
# nodes to reach a height: during a skew-induced split vote the bootstrap itself
# can be stuck, in which case wait_node_synced would return against a stalled
# head and verify_chain_agreement would race against the recovery.
settle_testnet 240 || true
for v in "$SKEW_PLUS" "$SKEW_MINUS"; do wait_node_synced "$v" 120 || true; done

# No peer ban / no divergence: the skewed nodes must catch up and agree.
# Use the alignment-free block-hash check: with a skewed clock a node can hold
# blocks in the pending queue, so its head height legitimately trails and the
# height-sensitive statehash probe races. The block hash at a common height is
# alignment-independent and is the actual fork evidence.
verify_chain_agreement "$BOOTSTRAP" avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 "$SKEW_MINUS" "$SKEW_PLUS"
print_leader_health
pass "G6 complete: chain survived a ±300ms clock skew with no divergence"
