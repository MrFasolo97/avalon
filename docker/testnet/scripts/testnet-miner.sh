#!/bin/bash
# miner.sh - Leader node entrypoint for testnet
set -euo pipefail

MINER_NAME="${NODE_OWNER}"
echo "=== Avalon Testnet - Miner: ${MINER_NAME} ==="

# Wait for config file from setup container
CONFIG_FILE="/avalon/config/testnet-keys/${MINER_NAME}.json"
echo "Waiting for config at $CONFIG_FILE..."
for i in $(seq 1 600); do
    if [ -f "$CONFIG_FILE" ]; then
        echo "Config found"
        export NODE_OWNER_PUB=$(node -e "console.log(require('$CONFIG_FILE').pub)")
        export NODE_OWNER_PRIV=$(node -e "console.log(require('$CONFIG_FILE').priv)")
        echo "Pub: ${NODE_OWNER_PUB:0:16}... Priv: ${NODE_OWNER_PRIV:0:8}..."
        break
    fi
    sleep 2
done

if [ -z "${NODE_OWNER_PUB:-}" ]; then
    echo "ERROR: No config found for ${MINER_NAME} at ${CONFIG_FILE}"
    exit 1
fi

rm -rf /avalon/blocks/* 2>/dev/null || true

echo "Starting Avalon node..."
cd /avalon
exec node --stack-size=65500 src/main
