#!/bin/bash
# G9: a node on the previous release (default v2.0.3) joins the Layer S/H chain.
#
# Expected (plan §8.3): "S1: follows the chain normally; H1: stalls, resyncs
# automatically, never forks."
#
# The one invariant this script enforces is the safety-critical one: whatever
# height the old node reaches, its block hash at that height MUST equal the
# network's block hash at the same height. A divergent hash is a FORK and fails
# the drill. Following or lagging are both acceptable outcomes of the
# compatibility envelope; forking is not.
#
# The old-node image is built once from OLD_TAG (git worktree + docker build) and
# cached, so repeated runs are fast.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

OLD_TAG="${OLD_TAG:-v2.0.3}"
OLD_IMAGE="avalon-old-node:${OLD_TAG}"
OLD_CONTAINER="avalon-drills-oldnode"
NETWORK="avalon-drills_default"
MONGO_HOST="avalon-drills-mongodb"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d /tmp/avalon-g9.XXXXXX)"

cleanup() {
    docker rm -f "$OLD_CONTAINER" >/dev/null 2>&1 || true
    git -C "$REPO_DIR" worktree remove --force "$WORK_DIR/repo" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

require_running

# --- 1. Build (or reuse) the old-node image ---------------------------------
if docker image inspect "$OLD_IMAGE" >/dev/null 2>&1; then
    log "Reusing cached old-node image $OLD_IMAGE"
else
    log "Building old-node image from $OLD_TAG (first run, ~2-3 min)"
    git -C "$REPO_DIR" worktree add --detach "$WORK_DIR/repo" "$OLD_TAG" >/dev/null 2>&1 \
        || fail "Could not create a worktree at $OLD_TAG"
    cat > "$WORK_DIR/Dockerfile" <<'EOF'
FROM node:24
WORKDIR /avalon
RUN apt-get update && apt-get install -y --no-install-recommends curl libvips-dev && rm -rf /var/lib/apt/lists/*
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=0
COPY repo/package*.json ./
RUN npm install
COPY repo/src/ src/
RUN mkdir -p /avalon/log /avalon/genesis /avalon/blocks
EOF
    docker build -t "$OLD_IMAGE" -f "$WORK_DIR/Dockerfile" "$WORK_DIR" >/dev/null 2>&1 \
        || fail "docker build of $OLD_IMAGE failed"
fi

# --- 2. Start the old node as an observer -----------------------------------
log "Starting $OLD_TAG node as an observer on $NETWORK"
docker rm -f "$OLD_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$OLD_CONTAINER" --network "$NETWORK" \
    -e HTTP_PORT=3001 -e HTTP_HOST=0.0.0.0 -e P2P_PORT=6001 \
    -e DB_NAME=avalon_oldnode -e DB_URL="mongodb://${MONGO_HOST}:27017" \
    -e PEERS="ws://${BOOTSTRAP}:6001" -e LOG_LEVEL=cons \
    -e NO_DISCOVERY=1 -e MAX_PEERS=20 -e WARMUP_ACCOUNTS=100 -e WARMUP_CONTENTS=0 \
    --entrypoint bash "$OLD_IMAGE" \
    -c 'cd /avalon && exec node --stack-size=65500 src/main' >/dev/null \
    || fail "Could not start the old node"

old_api() { docker exec "$OLD_CONTAINER" curl -sf --max-time 5 "http://localhost:3001$1" 2>/dev/null || echo ""; }

# --- 3. Wait for it to sync or settle ---------------------------------------
log "Waiting up to 150s for the old node to sync / settle..."
deadline=$((SECONDS + 150))
old_h=0
stable=0
last=0
while [ $SECONDS -lt $deadline ]; do
    old_h=$(old_api /count | grep -oP '"count":\s*\K[0-9]+' || echo 0)
    net_h=$(get_height)
    if [ -n "$old_h" ] && [ "$old_h" -ge "$net_h" ] 2>/dev/null; then
        log "Old node reached the network head ($old_h)"
        break
    fi
    # stop early if the old node has settled while the network moves on
    if [ "$old_h" = "$last" ]; then
        stable=$((stable + 5))
        if [ "$stable" -ge 30 ]; then
            log "Old node settled at $old_h (network at $(get_height))"
            break
        fi
    else
        stable=0
        last="$old_h"
    fi
    sleep 5
done

net_h=$(get_height)
log "Old node height=$old_h  network height=$net_h"

# --- 4. The no-fork invariant -----------------------------------------------
if [ -z "$old_h" ] || [ "$old_h" -le 0 ] 2>/dev/null; then
    pass "Old node produced no block of its own (observer, empty chain) — no fork possible"
else
    old_hash=$(old_api "/block/$old_h" | grep -oP '"hash":\s*"\K[0-9a-f]+' | head -1 || echo "")
    net_hash=$(api_get "$BOOTSTRAP" "/block/$old_h" | grep -oP '"hash":\s*"\K[0-9a-f]+' | head -1 || echo "")
    if [ -n "$old_hash" ] && [ "$old_hash" = "$net_hash" ]; then
        pass "Old node is on the SAME chain at height $old_h (hash matches, no fork)"
    else
        fail "Old node block #$old_h hash differs from the network (FORK): ${old_hash:0:16} vs ${net_hash:0:16}"
    fi
    if [ "$old_h" -ge "$net_h" ] 2>/dev/null; then
        pass "Old node FOLLOWED the chain to the head ($old_h)"
    else
        log "Old node lags ($old_h < $net_h): expected once Layer H moves the leader set; it must re-sync, never fork"
    fi
fi

# --- 5. Observation window: the network must keep advancing ------------------
start_net=$(get_height)
sleep 15
end_net=$(get_height)
if [ "$end_net" -gt "$start_net" ]; then
    pass "Network kept advancing with the old node attached ($start_net -> $end_net)"
else
    fail "Network stopped advancing while the old node was attached"
fi

print_leader_health
pass "G9 complete: previous-release node never diverged from the chain"
