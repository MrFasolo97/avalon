#!/bin/bash
# miner.sh - Leader node entrypoint for testnet
set -euo pipefail

MINER_NAME="${NODE_OWNER}"
echo "=== Avalon Testnet - Miner: ${MINER_NAME} ==="

# Read config from shared volume if available
CONFIG_FILE="/avalon/config/testnet-keys/${MINER_NAME}.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "Loading config from $CONFIG_FILE"
    export NODE_OWNER_PUB=$(node -e "console.log(require('$CONFIG_FILE').pub)")
    export NODE_OWNER_PRIV=$(node -e "console.log(require('$CONFIG_FILE').priv)")
fi

# Start MongoDB
mongod --dbpath /var/lib/mongodb --logpath /var/log/mongod.log --fork
for i in $(seq 1 30); do
    if mongosh --quiet --eval "db.runCommand({ping:1})" &>/dev/null; then break; fi
    sleep 1
done

# Clean stale state
mongosh --quiet --eval "db.getSiblingDB('${DB_NAME:-avalon}').dropDatabase()" &>/dev/null || true
rm -rf /avalon/blocks/* 2>/dev/null || true

echo "Starting Avalon node..."
cd /avalon
exec node --stack-size=65500 src/main
