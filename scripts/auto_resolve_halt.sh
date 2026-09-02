#!/bin/bash
# auto_resolve_halt.sh - Automatic blockchain halt resolution (fallback)
# Detects chain stalls and attempts recovery including block truncation.
# This script is the LAST-RESORT fallback for the in-process force finalization
# mechanism (src/consensus.js). Force finalization automatically resolves block
# conflicts at the consensus level without data loss. This script handles
# scenarios force finalization cannot: no leader producing blocks, node crashes,
# MongoDB issues, or force finalization itself failing.
# Usage: ./scripts/auto_resolve_halt.sh [options]

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# === Configuration (may be overridden via env) ===
HTTP_PORT="${HTTP_PORT:-3001}"
HTTP_HOST="${HTTP_HOST:-0.0.0.0}"
HALT_TIMEOUT_SEC="${HALT_TIMEOUT_SEC:-30}"
MAX_REMOVE_BLOCKS="${MAX_REMOVE_BLOCKS:-10}"
BLOCKS_DIR="${BLOCKS_DIR:-}"
DB_NAME="${DB_NAME:-avalon}"
DB_URL="${DB_URL:-mongodb://localhost:27017}"
NODE_OWNER="${NODE_OWNER:-}"
DRY_RUN="${DRY_RUN:-0}"

# Truncation safety: prevent repeated truncation from wiping the chain
HALT_STATE_DIR="${HALT_STATE_DIR:-${PROJECT_DIR}/.avalon_halt}"
MAX_TOTAL_REMOVE="${MAX_TOTAL_REMOVE:-$((MAX_REMOVE_BLOCKS * 3))}"
STATE_FILE="${HALT_STATE_DIR}/state.json"

mkdir -p "$HALT_STATE_DIR"

load_state() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
    else
        echo '{"last_truncated_height":0,"total_removed":0,"last_truncation_ts":0}'
    fi
}

save_state() {
    echo "$1" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

check_truncation_safety() {
    local current_height="$1"
    local to_remove="$2"
    local state
    state=$(load_state)

    local last_height
    last_height=$(echo "$state" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).last_truncated_height||0))")
    local total_removed
    total_removed=$(echo "$state" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).total_removed||0))")

    # Prevent removing blocks that were already truncated before (no forward progress)
    # Skip this check when current_height is 0 (node was offline, height unknown)
    if [ "$current_height" -gt 0 ] && [ "$current_height" -le "$last_height" ]; then
        err "Chain height ($current_height) has not progressed since last truncation ($last_height). Refusing to truncate again."
        err "This prevents a loop that could wipe the entire chain."
        err "Manual intervention required."
        return 1
    fi

    # Enforce cumulative cap
    local new_total=$(( total_removed + to_remove ))
    if [ "$new_total" -gt "$MAX_TOTAL_REMOVE" ]; then
        err "Cumulative blocks removed ($new_total) would exceed MAX_TOTAL_REMOVE ($MAX_TOTAL_REMOVE). Refusing to truncate."
        err "Previously removed: $total_removed, attempting to remove: $to_remove more."
        err "Increase MAX_TOTAL_REMOVE or reset ${STATE_FILE} to force."
        return 1
    fi

    info "Truncation safety check passed (last_truncated=$last_height, total_removed=$total_removed, removing=$to_remove)"
    return 0
}

update_state_after_truncation() {
    local new_height="$1"
    local removed="$2"
    local state
    state=$(load_state)

    local total_removed
    total_removed=$(echo "$state" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).total_removed||0))")

    local new_state
    new_state=$(cat <<EOF
{
    "last_truncated_height": $new_height,
    "total_removed": $(( total_removed + removed )),
    "last_truncation_ts": $(date +%s)
}
EOF
)
    save_state "$new_state"
}

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }
err()  { log "ERROR: $*"; }
warn() { log "WARN: $*"; }
info() { log "INFO: $*"; }

api_get() {
    curl -sf --max-time 5 "http://${HTTP_HOST}:${HTTP_PORT}${1}" 2>/dev/null || true
}

# === Detection ===

get_latest_block() {
    local count
    count=$(api_get "/count" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).count))" 2>/dev/null || echo "")
    if [ -z "$count" ] || [ "$count" = "null" ]; then
        return 1
    fi
    local block_json
    block_json=$(api_get "/block/${count}")
    if [ -z "$block_json" ] || [ "$block_json" = "{}" ]; then
        return 1
    fi
    echo "$block_json"
}

get_config() {
    local cfg
    cfg=$(api_get "/config")
    if [ -z "$cfg" ] || [ "$cfg" = "{}" ]; then
        return 1
    fi
    echo "$cfg"
}

is_node_running() {
    if command -v pgrep &>/dev/null; then
        pgrep -f "node.*src/main" &>/dev/null
    elif command -v pidof &>/dev/null; then
        pidof "node" &>/dev/null
    else
        # fallback: try the HTTP endpoint
        api_get "/count" &>/dev/null
    fi
}

stop_node() {
    local pid
    pid=$(pgrep -f "node.*src/main" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        info "Stopping node (PID $pid)..."
        if [ "$DRY_RUN" = "1" ]; then
            info "[DRY-RUN] Would kill PID $pid"
            return 0
        fi
        kill "$pid" 2>/dev/null || true
        local waited=0
        while kill -0 "$pid" 2>/dev/null; do
            sleep 1
            waited=$((waited + 1))
            if [ "$waited" -ge 15 ]; then
                warn "Node did not stop gracefully, force killing..."
                kill -9 "$pid" 2>/dev/null || true
                sleep 1
                break
            fi
        done
        info "Node stopped"
    else
        info "Node is not running"
    fi
}

start_node_with_rebuild() {
    if [ "$DRY_RUN" = "1" ]; then
        info "[DRY-RUN] Would start node with REBUILD_STATE=1:"
        info "  REBUILD_STATE=1 node --stack-size=65500 src/main"
        return 0
    fi
    info "Starting node with REBUILD_STATE=1..."
    export REBUILD_STATE=1
    if [ -f scripts/start.sh ]; then
        exec bash scripts/start.sh
    else
        exec node --stack-size=65500 src/main
    fi
}

# === Block Truncation (BSON) ===

truncate_blocks_bson() {
    local remove_count="$1"
    local bson_path="${BLOCKS_DIR}/blocks.bson"
    local idx_path="${BLOCKS_DIR}/blocks.index"

    if [ ! -f "$bson_path" ]; then
        err "blocks.bson not found at $bson_path"
        return 1
    fi
    if [ ! -f "$idx_path" ]; then
        err "blocks.index not found at $idx_path"
        return 1
    fi

    info "Truncating BSON storage: removing $remove_count blocks"

    local output new_height
    output=$(IDX_PATH="$idx_path" BSON_PATH="$bson_path" REMOVE_COUNT="$remove_count" DRY_RUN="$DRY_RUN" node -e '
    const fs = require("fs");
    const idxPath = process.env.IDX_PATH;
    const bsonPath = process.env.BSON_PATH;
    const remove = parseInt(process.env.REMOVE_COUNT, 10);
    const isDryRun = process.env.DRY_RUN === "1";

    if (!fs.existsSync(idxPath)) { console.error("Index not found:", idxPath); process.exit(1); }
    if (!fs.existsSync(bsonPath)) { console.error("BSON not found:", bsonPath); process.exit(1); }

    const idxSize = fs.statSync(idxPath).size;
    const bsonSize = fs.statSync(bsonPath).size;
    const totalBlocks = idxSize / 8;
    const newHeight = totalBlocks - remove - 1;

    if (newHeight < 0) {
        console.error("Cannot remove", remove, "blocks from only", (totalBlocks-1), "total");
        process.exit(1);
    }

    const buf = Buffer.alloc(8);
    const idxFd = fs.openSync(idxPath, "r");
    fs.readSync(idxFd, buf, 0, 8, (newHeight + 1) * 8);
    fs.closeSync(idxFd);

    const high = buf.readUInt32LE(0);
    const low = buf.readUInt32LE(4);
    const truncPos = (BigInt(high) << 32n) + BigInt(low);
    const idxTruncSize = (newHeight + 1) * 8;

    if (Number(truncPos) > bsonSize || truncPos < 0n) {
        console.error("Invalid truncation position: " + truncPos + " (BSON file size: " + bsonSize + " bytes)");
        process.exit(1);
    }

    console.log("KEEPING blocks 0 - " + newHeight + " (" + (newHeight+1) + " total)");
    console.log("  index: " + idxSize + " -> " + idxTruncSize + " bytes");
    console.log("  bson:  " + bsonSize + " -> " + truncPos + " bytes");

    if (!isDryRun) {
        fs.truncateSync(idxPath, idxTruncSize);
        fs.truncateSync(bsonPath, Number(truncPos));
        console.log("Truncation done");
    } else {
        console.log("[DRY-RUN] No files modified");
    }

    console.log(newHeight);
    ') || return 1

    new_height=$(echo "$output" | tail -1)
    info "BSON truncation complete: kept blocks 0 - $new_height"
    echo "$new_height"
}

# === MongoDB Helpers ===

is_positive_integer() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

find_mongo_cmd() {
    if command -v mongosh &>/dev/null; then
        echo "mongosh"
    elif command -v mongo &>/dev/null; then
        echo "mongo"
    else
        return 1
    fi
}

run_mongo() {
    local mongo_cmd
    mongo_cmd=$(find_mongo_cmd) || return 1
    "$mongo_cmd" "$DB_URL/$DB_NAME" --quiet --eval "$1"
}

# === Block Truncation (MongoDB) ===

truncate_blocks_mongo() {
    local remove_count="$1"

    info "Truncating MongoDB storage: removing $remove_count blocks"

    local mongo_cmd
    mongo_cmd=$(find_mongo_cmd) || {
        err "Neither mongosh nor mongo CLI found"
        return 1
    }

    local output new_height

    output=$(REMOVE_COUNT="$remove_count" DRY_RUN="$DRY_RUN" run_mongo "
        const remove = parseInt(process.env.REMOVE_COUNT, 10);
        const isDryRun = process.env.DRY_RUN === '1';
        const lastBlock = db.blocks.find().sort({_id:-1}).limit(1).next();
        if (!lastBlock) {
            print('ERROR: No blocks found');
            quit(1);
        }
        const oldHeight = lastBlock._id;
        const newHeight = oldHeight - remove;
        if (newHeight < 0) {
            print('ERROR: Cannot remove ' + remove + ' blocks, only have ' + (oldHeight+1));
            quit(1);
        }
        if (isDryRun) {
            print('[DRY-RUN] Would delete ' + remove + ' blocks, keeping 0 - ' + newHeight);
        } else {
            const result = db.blocks.deleteMany({_id: {\$gt: newHeight}});
            print('Deleted ' + result.deletedCount + ' blocks');
        }
        print('KEEPING blocks 0 - ' + newHeight + ' (' + (newHeight+1) + ' total)');
        print(newHeight);
    ") || {
        err "MongoDB truncation failed"
        return 1
    }

    new_height=$(echo "$output" | tail -1)
    echo "$output" | head -n -1 | while IFS= read -r line; do info "$line"; done
    info "MongoDB truncation complete: kept blocks 0 - $new_height"
    echo "$new_height"
}

# === MongoDB State Cleanup ===

cleanup_mongodb_state() {
    local new_height="$1"

    local mongo_cmd
    mongo_cmd=$(find_mongo_cmd) || {
        err "Cannot find mongosh or mongo CLI for state cleanup"
        return 1
    }

    if [ -n "$BLOCKS_DIR" ]; then
        # BSON mode: blocks are safe in files, drop entire MongoDB
        info "Dropping MongoDB database (BSON mode, blocks are on disk)..."
        if [ "$DRY_RUN" = "1" ]; then
            info "[DRY-RUN] Would drop database $DB_NAME"
            return 0
        fi
        run_mongo "
            const result = db.dropDatabase();
            print('Database dropped: ' + JSON.stringify(result));
        " || {
            err "Failed to drop database"
            return 1
        }
        info "MongoDB database dropped successfully"
    else
        # MongoDB mode: preserve kept blocks, drop everything else
        local tmp_coll="blocks_tmp_truncation"
        info "Preserving kept blocks, resetting MongoDB state..."
        if [ "$DRY_RUN" = "1" ]; then
            info "[DRY-RUN] Would move kept blocks (≤ #$new_height) to temp, drop DB, restore"
            return 0
        fi
        if ! is_positive_integer "$new_height"; then
            err "Invalid block height: $new_height"
            return 1
        fi

        NEW_HEIGHT="$new_height" TMP_COLL="$tmp_coll" run_mongo "
            const newHeight = parseInt(process.env.NEW_HEIGHT, 10);
            const tmpColl = process.env.TMP_COLL;
            // Copy kept blocks to temp collection
            const docs = db.blocks.aggregate([
                {\$match: {_id: {\$lte: newHeight}}},
                {\$out: tmpColl}
            ]);
            const kept = db.getCollection(tmpColl).countDocuments();
            if (kept === 0) {
                print('ERROR: No blocks to preserve');
                quit(1);
            }
            print('Preserved ' + kept + ' blocks (0 - #' + newHeight + ')');

            // Drop everything except temp collection
            db.getCollectionNames().forEach(function(c) {
                if (c !== tmpColl) {
                    db.getCollection(c).drop();
                }
            });
            print('Collections dropped (except temp)');

            // Restore blocks from temp
            db.getCollection(tmpColl).aggregate([
                {\$match: {}},
                {\$out: 'blocks'}
            ]);
            db.getCollection(tmpColl).drop();
            print('Blocks restored, temp collection removed');
        " || {
            err "Failed to reset MongoDB state"
            return 1
        }
        info "MongoDB state reset, blocks preserved"
    fi
}

# === Halt Detection Logic ===

check_halt() {
    info "Checking blockchain status..."

    if ! is_node_running; then
        err "Node is not running"
        return 2
    fi

    local block_json
    block_json=$(get_latest_block) || {
        err "Cannot get latest block (HTTP API not responding)"
        return 2
    }

    local height timestamp miner
    height=$(echo "$block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b._id)})")
    timestamp=$(echo "$block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b.timestamp)})")
    miner=$(echo "$block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b.miner)})")

    local now
    now=$(date +%s%3N)
    local elapsed=$(( (now - timestamp) / 1000 ))

    info "Latest block: #$height by $miner, ${elapsed}s ago"

    if [ "$elapsed" -gt "$HALT_TIMEOUT_SEC" ]; then
        warn "Chain appears halted! Last block was ${elapsed}s ago (timeout: ${HALT_TIMEOUT_SEC}s)"
        return 1
    fi

    info "Chain is healthy (last block ${elapsed}s ago)"
    return 0
}

# === Recovery Steps ===

try_recover() {
    info "Step 1: Trying /recover endpoint..."
    local resp
    resp=$(api_get "/recover")
    info "Recovery triggered: $(echo "$resp" | head -c 200)"
    sleep 10

    if check_halt; then
        info "Chain recovered after /recover"
        return 0
    fi
    warn "Chain still halted after /recover"
    return 1
}

try_mine_block() {
    info "Step 2: Trying /mineBlock endpoint..."
    if [ -n "$NODE_OWNER" ]; then
        info "NODE_OWNER is '$NODE_OWNER' - attempting forced block production"
    fi
    local resp
    resp=$(api_get "/mineBlock" 2>/dev/null || echo "failed")
    info "mineBlock response: $(echo "$resp" | head -c 200)"
    sleep 10

    if check_halt; then
        info "Chain recovered after /mineBlock"
        return 0
    fi
    warn "Chain still halted after /mineBlock"
    return 1
}

wait_force_finalize() {
    local cfg="$1"
    local force_finalize
    force_finalize=$(echo "$cfg" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const c=JSON.parse(d);console.log(c.forceFinalize===true?'true':'false')})" 2>/dev/null || echo "false")

    if [ "$force_finalize" != "true" ]; then
        info "skip wait: forceFinalize not enabled in config"
        return 1
    fi

    local leaders block_time consensus_rounds
    leaders=$(echo "$cfg" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).leaders||5))" 2>/dev/null || echo "5")
    block_time=$(echo "$cfg" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).blockTime||3000))" 2>/dev/null || echo "3000")
    consensus_rounds=$(echo "$cfg" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).consensusRounds||2))" 2>/dev/null || echo "2")

    local wait_ms=$(( block_time * (leaders + consensus_rounds + 2) + 10000 ))
    local wait_sec=$(( wait_ms / 1000 ))

    info "forceFinalize is enabled — waiting up to ${wait_sec}s for automatic resolution (timeout=${block_time}ms * (leaders=${leaders} + rounds=${consensus_rounds} + 2) + 10s margin)"

    local block_json before_height now deadline
    block_json=$(get_latest_block) || true
    before_height=$(echo "$block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b._id)})" 2>/dev/null || echo "0")
    now=$(date +%s)
    deadline=$(( now + wait_sec ))

    while [ "$(date +%s)" -lt "$deadline" ]; do
        sleep 5
        if check_halt 2>/dev/null; then
            info "Chain recovered during auto-wait (force finalization or normal consensus resumed)"
            return 0
        fi
        local new_block_json
        new_block_json=$(get_latest_block) || continue
        local new_height
        new_height=$(echo "$new_block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b._id)})" 2>/dev/null || echo "0")
        if [ "$new_height" -gt "$before_height" ]; then
            info "Chain progressed to height $new_height (was $before_height) — halt resolved"
            return 0
        fi
    done

    warn "Force finalization did not resolve halt within ${wait_sec}s — proceeding to truncation"
    return 1
}

# === Main Flow ===

show_help() {
    cat <<'EOF'
auto_resolve_halt.sh - Blockchain halt resolution (LAST-RESORT fallback)

Detects chain stalls and attempts recovery. This is the external fallback
for the in-process force finalization mechanism (src/consensus.js) which
automatically resolves block collisions at the consensus level.

Recovery steps:
  1. Calls /recover to try P2P sync
  2. Calls /mineBlock to force block production
  3. Waits for in-process force finalization if enabled in config
  4. Removes up to maxLeaders*2 blocks as last resort

Note: If forceFinalize is enabled, the node auto-resolves block conflicts.
      This script is only needed when no leader produces blocks at all,
      when force finalization is not enabled, or when it fails.

Usage:
  ./scripts/auto_resolve_halt.sh [options]

Options:
  --check               Only check if chain is halted (exit 1 if halted)
  --recover             Run recovery steps but do NOT truncate blocks
  --force-remove=N      Remove N blocks and restart (skip detection)
  --dry-run             Show what would be done without making changes
  --help                Show this help

Environment variables:
  HTTP_PORT             HTTP API port (default: 3001)
  HTTP_HOST             HTTP API host (default: 0.0.0.0)
  HALT_TIMEOUT_SEC      Seconds before considering chain halted (default: 30)
  MAX_REMOVE_BLOCKS     Max blocks to remove per truncation (default: 10)
  MAX_TOTAL_REMOVE      Cumulative cap on total blocks removed (default: MAX_REMOVE_BLOCKS*3)
  HALT_STATE_DIR        Directory for truncation state tracking (default: .avalon_halt)
  BLOCKS_DIR            BSON blocks directory (if using BSON storage)
  DB_NAME               MongoDB database name (default: avalon)
  DB_URL                MongoDB URL (default: mongodb://localhost:27017)
  NODE_OWNER            Your node owner name (for /mineBlock)
  DRY_RUN               Set to 1 for dry-run mode (default: 0)

Config note: If node config has forceFinalize=true, the script will
  automatically wait for the in-process force finalization timeout
  (blockTime * (leaders + consensusRounds + 2) ms + 10s margin)
  before proceeding to block truncation.
EOF
}

do_check() {
    if check_halt; then
        info "Chain is running normally"
        exit 0
    else
        local rc=$?
        if [ "$rc" = "2" ]; then
            info "Cannot determine chain status (node may be offline)"
            exit 2
        fi
        info "Chain is halted"
        exit 1
    fi
}

do_recover() {
    info "=== Recovery Mode ==="
    if ! is_node_running; then
        err "Node is not running, start it first"
        exit 1
    fi

    local halt_rc=0
    check_halt || halt_rc=$?

    if [ "$halt_rc" = "2" ]; then
        exit 1
    fi

    try_recover && exit 0
    try_mine_block && exit 0

    info "Recovery steps completed, chain still halted."
    info "Use --force-remove=N or run without flags to truncate blocks."
    exit 1
}

do_force_remove() {
    local remove_count="$1"

    if ! [[ "$remove_count" =~ ^[0-9]+$ ]] || [ "$remove_count" -le 0 ]; then
        err "Invalid block count: $remove_count"
        exit 1
    fi

    info "=== Force Remove Mode: removing $remove_count blocks ==="

    # Get current height before stopping
    local current_height=0
    if is_node_running; then
        local block_json
        block_json=$(get_latest_block) || true
        if [ -n "$block_json" ]; then
            current_height=$(echo "$block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b._id)})")
        fi
    fi

    # Safety check (enforced even when node is offline)
    if [ "$current_height" -gt 0 ]; then
        check_truncation_safety "$current_height" "$remove_count" || exit 1
    else
        check_truncation_safety 0 "$remove_count" || exit 1
    fi

    stop_node

    local new_height=0
    if [ -n "$BLOCKS_DIR" ]; then
        new_height=$(truncate_blocks_bson "$remove_count")
    else
        new_height=$(truncate_blocks_mongo "$remove_count")
    fi

    if [ -n "$new_height" ]; then
        update_state_after_truncation "$new_height" "$remove_count"
    fi

    cleanup_mongodb_state "$new_height"
    start_node_with_rebuild
}

do_auto_resolve() {
    info "=== Auto-Resolve Halt ==="

    if ! is_node_running; then
        info "Node not running. Use --force-remove=N to truncate and start."
        exit 1
    fi

    check_halt || true
    local rc=$?
    if [ "$rc" = "2" ]; then
        exit 1
    fi
    if [ "$rc" = "0" ]; then
        info "No action needed."
        exit 0
    fi

    # Chain is halted, try recovery steps
    try_recover && exit 0
    try_mine_block && exit 0

    # Still halted — check if force finalization can resolve conflicts in-process
    info "Step 3: /recover and /mineBlock failed — checking force finalization..."

    local cfg
    cfg=$(get_config) || true
    if [ -n "$cfg" ]; then
        if wait_force_finalize "$cfg"; then
            info "Halt resolved via force finalization"
            exit 0
        fi
    else
        warn "Cannot fetch config, skipping forceFinalize wait"
    fi

    info "Step 4: Force finalization did not resolve halt — preparing block truncation..."

    cfg=$(get_config) || {
        warn "Cannot fetch config, using defaults: leaders=5, blockTime=3000"
        local leaders=5
        local block_time=3000
    }
    if [ -n "$cfg" ]; then
        leaders=$(echo "$cfg" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).leaders||5))")
        block_time=$(echo "$cfg" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).blockTime||3000))")
    fi

    local max_remove=$(( leaders * 2 ))
    # Use user-configured max if smaller
    [ "$MAX_REMOVE_BLOCKS" -lt "$max_remove" ] && max_remove="$MAX_REMOVE_BLOCKS"

    info "Config: leaders=$leaders, blockTime=${block_time}ms, maxRemove=$max_remove"

    # Calculate halt duration in blocks
    local block_json
    block_json=$(get_latest_block) || true
    local latest_height=0 latest_ts=0
    if [ -n "$block_json" ]; then
        latest_height=$(echo "$block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b._id)})")
        latest_ts=$(echo "$block_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const b=JSON.parse(d);console.log(b.timestamp)})")
    fi
    local now_ms
    now_ms=$(date +%s%3N)
    local halt_ms=$(( now_ms - latest_ts ))
    local halt_blocks=$(( halt_ms / block_time ))

    # Remove up to max_remove, but at least 1 (if truly halted)
    local to_remove=$(( halt_blocks > max_remove ? max_remove : halt_blocks ))
    [ "$to_remove" -lt 1 ] && to_remove=1

    info "Halt duration: ~${halt_blocks} blocks, removing ${to_remove}"

    # Safety check: prevent repeated truncation from wiping the chain
    check_truncation_safety "$latest_height" "$to_remove" || exit 1

    stop_node

    local new_height=0
    if [ -n "$BLOCKS_DIR" ]; then
        new_height=$(truncate_blocks_bson "$to_remove")
    else
        new_height=$(truncate_blocks_mongo "$to_remove")
    fi

    if [ -n "$new_height" ]; then
        update_state_after_truncation "$new_height" "$to_remove"
    fi

    cleanup_mongodb_state "$new_height"
    start_node_with_rebuild
}

# === Parse arguments ===
MODE="auto"
FORCE_REMOVE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            show_help
            exit 0
            ;;
        --check)
            MODE="check"
            ;;
        --recover)
            MODE="recover"
            ;;
        --force-remove=*)
            MODE="force_remove"
            FORCE_REMOVE="${1#*=}"
            ;;
        --force-remove)
            MODE="force_remove"
            FORCE_REMOVE="$2"
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            ;;
        *)
            err "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
    shift
done

case "$MODE" in
    check)        do_check ;;
    recover)      do_recover ;;
    force_remove) do_force_remove "$FORCE_REMOVE" ;;
    auto)         do_auto_resolve ;;
esac
