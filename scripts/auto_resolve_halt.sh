#!/bin/bash
# auto_resolve_halt.sh - Automatic blockchain halt resolution
# Detects chain stalls and attempts recovery including block truncation.
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

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err()  { log "ERROR: $*" >&2; }
warn() { log "WARN: $*" >&2; }
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
    output=$(node -e '
    const fs = require("fs");
    const idxPath = "'"$idx_path"'";
    const bsonPath = "'"$bson_path"'";
    const remove = '"$remove_count"';
    const isDryRun = "'"$DRY_RUN"'" === "1";

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
    const truncPos = (BigInt(high) << 8n) + BigInt(low);
    const idxTruncSize = (newHeight + 1) * 8;

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
    "$mongo_cmd" "$DB_URL/$DB_NAME" --quiet --eval "$1" 2>/dev/null
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

    output=$(run_mongo "
        const lastBlock = db.blocks.find().sort({_id:-1}).limit(1).next();
        if (!lastBlock) {
            print('ERROR: No blocks found');
            quit(1);
        }
        const oldHeight = lastBlock._id;
        const newHeight = oldHeight - $remove_count;
        if (newHeight < 0) {
            print('ERROR: Cannot remove $remove_count blocks, only have ' + (oldHeight+1));
            quit(1);
        }
        const isDryRun = "'"$DRY_RUN"'" === "1";
        if (isDryRun) {
            print('[DRY-RUN] Would delete ' + $remove_count + ' blocks, keeping 0 - ' + newHeight);
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
        run_mongo "
            const newHeight = $new_height;
            // Copy kept blocks to temp collection
            const docs = db.blocks.aggregate([
                {\$match: {_id: {\$lte: newHeight}}},
                {\$out: '$tmp_coll'}
            ]);
            const kept = db.getCollection('$tmp_coll').countDocuments();
            if (kept === 0) {
                print('ERROR: No blocks to preserve');
                quit(1);
            }
            print('Preserved ' + kept + ' blocks (0 - #' + newHeight + ')');

            // Drop everything
            db.dropDatabase();
            print('Database dropped');

            // Restore blocks from temp
            db.getCollection('$tmp_coll').aggregate([
                {\$match: {}},
                {\$out: 'blocks'}
            ]);
            db.getCollection('$tmp_coll').drop();
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

# === Main Flow ===

show_help() {
    cat <<'EOF'
auto_resolve_halt.sh - Automatic blockchain halt resolution

Detects chain stalls and attempts recovery:
  1. Calls /recover to try P2P sync
  2. Calls /mineBlock to force block production
  3. Removes up to maxLeaders*2 blocks as last resort

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
  MAX_REMOVE_BLOCKS     Max blocks to remove (default: 10 = maxLeaders*2)
  BLOCKS_DIR            BSON blocks directory (if using BSON storage)
  DB_NAME               MongoDB database name (default: avalon)
  DB_URL                MongoDB URL (default: mongodb://localhost:27017)
  NODE_OWNER            Your node owner name (for /mineBlock)
  DRY_RUN               Set to 1 for dry-run mode (default: 0)
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

    check_halt || true

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
    stop_node

    local new_height=0
    if [ -n "$BLOCKS_DIR" ]; then
        new_height=$(truncate_blocks_bson "$remove_count")
    else
        new_height=$(truncate_blocks_mongo "$remove_count")
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

    # Still halted - get config to determine max blocks to remove
    info "Step 3: Recovery failed, preparing block truncation..."

    local cfg
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
    local latest_ts=0
    if [ -n "$block_json" ]; then
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

    stop_node

    local new_height=0
    if [ -n "$BLOCKS_DIR" ]; then
        new_height=$(truncate_blocks_bson "$to_remove")
    else
        new_height=$(truncate_blocks_mongo "$to_remove")
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
