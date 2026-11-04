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

# Verify the statehash matches across the given containers.
#
# The hash includes the head height, so on a live chain a naive read races
# (node A read at height h, node B at h+1) and looks like a divergence. Retry
# until every container reports the SAME height in one poll, and compare only
# then: a mismatch at equal height is a real divergence.
#
# Right after a mass restart (G10) the nodes rebuild their derived state while
# catching up, so for a short window the hash differs transiently even though
# the blocks are identical. This is why the check retries for a few minutes
# (STATEHASH_ATTEMPTS) instead of comparing once.
verify_statehash_match() {
    local containers=("$@")
    local attempts="${STATEHASH_ATTEMPTS:-90}"
    local a c hh hash
    for a in $(seq 1 "$attempts"); do
        local heights=() same=1 firstH=""
        for c in "${containers[@]}"; do
            hh=$(api_get "$c" "/count" | grep -oP '"count":\s*\K[0-9]+' || echo "")
            heights+=("$hh")
        done
        firstH="${heights[0]:-}"
        for hh in "${heights[@]}"; do
            if [ -z "$hh" ] || [ "$hh" != "$firstH" ]; then same=0; fi
        done
        if [ "$same" -eq 1 ] && [ -n "$firstH" ]; then
            local first="" mismatch=""
            for c in "${containers[@]}"; do
                hash=$(get_statehash "$c")
                if [ -z "$hash" ]; then
                    fail "Could not fetch statehash from $c"
                fi
                if [ -z "$first" ]; then
                    first="$hash"
                elif [ "$first" != "$hash" ]; then
                    mismatch="$c"
                    break
                fi
            done
            if [ -z "$mismatch" ]; then
                pass "Statehash matches on ${#containers[@]} node(s) at height $firstH"
                return 0
            fi
        fi
        sleep 2
    done
    fail "Statehash mismatch (or heights never converged) across: ${containers[*]}"
}
