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

# Patch config for testnet (matches genesis.sh — ensures consistent config across nodes)
node -e "
const fs = require('fs');
let c = fs.readFileSync('/avalon/src/config.js', 'utf8');
c = c.replace(/masterDaoTxs: \[[^\]]*\]/, 'masterDaoTxs: [0,1,2,3,4,5,6,7,8,10,11,12,13,14,15,17,18,19,20,21,23,24,25,26,27,28,29,30,32]');
if (!c.includes('100:'))
  c = c.replace('241600: {', '100: {\\n            forceFinalize: true,\\n        },\\n        241600: {');
fs.writeFileSync('/avalon/src/config.js', c);
"

echo "Starting Avalon node..."
cd /avalon
exec node --stack-size=65500 src/main
