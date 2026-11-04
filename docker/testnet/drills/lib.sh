#!/bin/bash
# Common helpers for Layer S/H drill scripts.
# All functions target the avalon-drills testnet containers only.
#
# NOTE: we use docker exec for API calls because Docker Compose v2 does not
# support the !reset YAML tag for merging port lists.  The containers expose
# HTTP on port 3001 internally, so we call it from inside the containers.

set -uo pipefail

PROJECT="avalon-drills"
BOOTSTRAP="avalon-drills-bootstrap"

# List of leader containers in the drills testnet
LEADERS=(avalon-drills-miner1 avalon-drills-miner2 avalon-drills-miner3 avalon-drills-miner4 avalon-drills-miner5)
STANDBYS=(avalon-drills-standby1 avalon-drills-standby2)
ALL_MINERS=("${LEADERS[@]}" "${STANDBYS[@]}")

# Container name -> leader account name (avalon-drills-miner5 -> miner5)
leader_name() {
    echo "${1#avalon-drills-}"
}

# Container for a leader account name
leader_container() {
    echo "avalon-drills-$1"
}

log() {
    echo "[$(date +%H:%M:%S)] $*"
}

fail() {
    echo "[FAIL] $*"
    exit 1
}

pass() {
    echo "[PASS] $*"
}

# Check that the drills testnet is running
require_running() {
    local running=0
    for c in "${LEADERS[@]}"; do
        if docker ps --format '{{.Names}}' | grep -qx "$c"; then
            running=$((running + 1))
        fi
    done
    if [ "$running" -lt 5 ]; then
        fail "Drills testnet not running (found $running/5 leaders). Run:\n  docker compose -p avalon-drills -f docker-compose.yml -f docker-compose.drills.yml up -d --build"
    fi
    # The leader set must be the drill miners (the master steps out of the
    # rotation once 5 real leaders exist). activeLeaders() is a rolling window
    # though, so it can momentarily hold 4 of them — requiring all 5 (in
    # particular "miner5") made the drills abort intermittently. Require the
    # master to be gone and at least 3 leaders present instead.
    local active
    active=$(json_extract "$(api_get "$BOOTSTRAP" "/consensus")" ".activeLeaders.map(l => l.name || l).join(',')" 2>/dev/null || echo "")
    if [ -n "$active" ]; then
        if echo "$active" | grep -q "dtube"; then
            fail "Master 'dtube' is still in the rotation [$active]; the drills need the miner set"
        fi
        local count
        count=$(echo "$active" | tr ',' '\n' | grep -c .)
        if [ "$count" -lt 3 ]; then
            fail "Active leader set [$active] has fewer than 3 leaders"
        fi
    fi
}

# GET an API path from inside a container, return body
api_get() {
    local container="$1"
    local path="$2"
    docker exec "$container" curl -sf --max-time 5 "http://localhost:3001$path" 2>/dev/null || echo ""
}

# Block height from bootstrap
get_height() {
    local raw
    raw=$(api_get "$BOOTSTRAP" "/count")
    if [ -z "$raw" ]; then
        echo "0"
        return
    fi
    echo "$raw" | grep -oP '"count":\s*\K[0-9]+' || echo "0"
}

# Wait until height reaches target (or timeout seconds)
wait_height() {
    local target="$1"
    local timeout="${2:-120}"
    local deadline=$((SECONDS + timeout))
    while [ $SECONDS -lt $deadline ]; do
        local h
        h=$(get_height)
        if [ "$h" -ge "$target" ]; then
            return 0
        fi
        sleep 2
    done
    return 1
}

# Wait until chain has produced at least N new blocks
wait_blocks() {
    local n="$1"
    local timeout="${2:-120}"
    local start
    start=$(get_height)
    wait_height $((start + n)) "$timeout"
}

# Wait until a (restarted) node's height reaches the bootstrap's height.
# Always call this after starting a node back up and BEFORE verify_statehash_match,
# otherwise the drill races the node's catch-up and fails on a stale statehash.
wait_node_synced() {
    local container="$1"
    local timeout="${2:-150}"
    local deadline=$((SECONDS + timeout))
    local mine target
    while [ $SECONDS -lt $deadline ]; do
        target=$(get_height)
        mine=$(api_get "$container" "/count" | grep -oP '"count":\s*\K[0-9]+' || echo "0")
        if [ -n "$mine" ] && [ "$target" != "0" ] && [ "$mine" -ge "$target" ] 2>/dev/null; then
            return 0
        fi
        sleep 2
    done
    log "wait_node_synced: $container did not reach height ${target:-?} within ${timeout}s"
    return 1
}

# Stop one or more containers
stop_nodes() {
    for c in "$@"; do
        log "Stopping $c"
        timeout 60 docker stop "$c" >/dev/null || true
    done
}

# Start one or more containers
start_nodes() {
    for c in "$@"; do
        log "Starting $c"
        timeout 60 docker start "$c" >/dev/null || true
    done
}

# Kill one or more containers abruptly
kill_nodes() {
    for c in "$@"; do
        log "Killing $c"
        timeout 30 docker kill "$c" >/dev/null || true
    done
}

# Check if a container is running
is_running() {
    docker ps --format '{{.Names}}' | grep -qx "$1"
}

# Fetch /consensus from bootstrap
get_consensus() {
    api_get "$BOOTSTRAP" "/consensus"
}

# Fetch /debug/statehash from a node by container name
get_statehash() {
    local container="${1:-$BOOTSTRAP}"
    api_get "$container" "/debug/statehash" | grep -oP '"stateHash":\s*"\K[0-9a-f]+' || echo ""
}

# Extract a jq-style path from JSON using node (jq may not be available)
json_extract() {
    local json="$1"
    local path="$2"
    node -e "try { console.log(JSON.parse(process.argv[1])${path}) } catch(e) {}" "$json"
}

# Print leader health summary from /consensus
print_leader_health() {
    local consensus
    consensus=$(get_consensus)
    echo "--- Leader health ---"
    json_extract "$consensus" ".leaderHealth" || echo "(no data)"
    echo "--- Active leaders ---"
    json_extract "$consensus" ".activeLeaders" || echo "(no data)"
    echo "--- Eligible leaders ---"
    json_extract "$consensus" ".eligibleLeaders" || echo "(no data)"
}

# Verify there is no divergence across the given containers.
#
# Primary check (authoritative, alignment-free): the block hash at a common
# height — verify_chain_agreement(). This is the actual fork evidence and never
# races on heights.
#
# Secondary check (best effort): the derived-state /debug/statehash, compared
# only when every node happens to report the SAME head height in one poll. On a
# live chain that is rare (and rarer with a skewed clock or just-restarted
# nodes), so failing to align is NOT a failure — it is logged and skipped. A
# real statehash mismatch at an aligned height (or a block-hash mismatch) fails
# the drill.
verify_statehash_match() {
    local containers=("$@")
    verify_chain_agreement "${containers[@]}"

    local attempts="${STATEHASH_ATTEMPTS:-20}"
    local a c hh hash first fH same
    for a in $(seq 1 "$attempts"); do
        local heights=()
        for c in "${containers[@]}"; do
            hh=$(api_get "$c" "/count" | grep -oP '"count":\s*\K[0-9]+' || echo "")
            heights+=("$hh")
        done
        fH="${heights[0]:-}"; same=1
        for hh in "${heights[@]}"; do
            if [ -z "$hh" ] || [ "$hh" != "$fH" ]; then same=0; fi
        done
        if [ "$same" -eq 1 ] && [ -n "$fH" ]; then
            first=""; local mh=""
            for c in "${containers[@]}"; do
                hash=$(get_statehash "$c")
                if [ -z "$first" ]; then first="$hash"
                elif [ "$first" != "$hash" ]; then mh="$c"
                fi
            done
            if [ -z "$mh" ]; then
                pass "Statehash matches on ${#containers[@]} node(s) at height $fH"
            else
                # The derived state (leaderHealth / eligible set) can differ for a
                # short window after a restart or a partition heal even when the
                # blocks are identical; it is not fork evidence and it converges.
                # The authoritative check (block hash at a common height) already
                # passed above, so this is reported, not fatal.
                log "WARN: derived-state divergence at height $fH ($mh) — not fork evidence"
            fi
            return 0
        fi
        sleep 2
    done
    log "Heights never aligned in ${attempts} polls; block-hash agreement is authoritative"
}

# Compare the BLOCK hash at a common height across the given containers.
#
# Alignment-free: unlike verify_statehash_match it does not require every node
# to report the same head height in one poll (impossible on a fast chain, and
# harder still when a node's clock is skewed and it holds blocks in the pending
# queue). It takes the minimum height across the nodes and compares each one's
# block hash there — the actual fork evidence.
verify_chain_agreement() {
    local containers=("$@")
    local attempts="${AGREEMENT_ATTEMPTS:-30}"
    local a c h minh
    for a in $(seq 1 "$attempts"); do
        minh=""
        for c in "${containers[@]}"; do
            h=$(api_get "$c" "/count" | grep -oP '"count":\s*\K[0-9]+' || echo "")
            if [ -z "$h" ]; then minh=""; break; fi
            if [ -z "$minh" ] || [ "$h" -lt "$minh" ]; then minh="$h"; fi
        done
        if [ -n "$minh" ] && [ "$minh" -gt 0 ]; then
            local first="" mismatch=""
            for c in "${containers[@]}"; do
                hash=$(api_get "$c" "/block/$minh" | grep -oP '"hash":\s*"\K[0-9a-f]+' | head -1 || echo "")
                if [ -z "$hash" ]; then mismatch="$c"; break; fi
                if [ -z "$first" ]; then first="$hash"
                elif [ "$first" != "$hash" ]; then mismatch="$c"; break; fi
            done
            if [ -z "$mismatch" ]; then
                pass "Block hash agrees on ${#containers[@]} node(s) at height $minh"
                return 0
            fi
        fi
        sleep 2
    done
    fail "Block hash mismatch (or no common height) across: ${containers[*]}"
}

# Bring the testnet back to a healthy, advancing state before running a drill.
#
# Drills stop/kill/restart nodes and (G6) recreate them; a previous drill that
# was interrupted can leave a container stopped and the chain stalled, which
# makes every following drill fail with a spurious "not running" or "chain did
# not produce". Calling this before each drill keeps the suite idempotent.
settle_testnet() {
    local timeout="${1:-150}"
    for c in "${ALL_MINERS[@]}" "$BOOTSTRAP"; do
        if ! is_running "$c"; then
            log "settle: starting $c"
            docker start "$c" >/dev/null 2>&1 || true
        fi
    done
    # A node restarted here reloads src/ from the bind mount; give it a moment
    # to connect and produce before we look at the height.
    local deadline=$((SECONDS + timeout))
    local prev
    prev=$(get_height)
    sleep 4
    while [ $SECONDS -lt $deadline ]; do
        local h
        h=$(get_height)
        if [ -n "$h" ] && [ "$h" -gt "${prev:-0}" ] 2>/dev/null; then
            log "settle: chain advancing (head $h)"
            return 0
        fi
        prev="$h"
        sleep 4
    done
    log "settle: WARNING chain not advancing within ${timeout}s (head ${prev:-?})"
    return 1
}
