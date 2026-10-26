#!/bin/bash
# testnet-jail-miner.sh — leader node entrypoint for the offline-leader (jail) testnet.
#
# Same as testnet-miner.sh but without the runtime src/config.js patch: the jail and
# quorum parameters arrive through the container environment (see docker-compose.jail.yml).
set -euo pipefail

MINER_NAME="${NODE_OWNER}"
echo "=== Avalon Jail Testnet - Miner: ${MINER_NAME} ==="

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

echo "Starting Avalon node (jail prototype)..."
cd /avalon
exec node --stack-size=65500 src/main
