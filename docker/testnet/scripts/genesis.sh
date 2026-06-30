#!/bin/bash
# genesis.sh - Bootstrap node entrypoint for testnet
set -euo pipefail

echo "=== Avalon Testnet - Bootstrap Node ==="

# Start MongoDB
mongod --dbpath /var/lib/mongodb --logpath /var/log/mongod.log --fork
for i in $(seq 1 30); do
    if mongosh --quiet --eval "db.runCommand({ping:1})" &>/dev/null; then break; fi
    sleep 1
done

# Fresh testnet: drop any stale data
mongosh --quiet --eval "db.getSiblingDB('${DB_NAME:-avalon}').dropDatabase()" &>/dev/null || true
rm -rf /avalon/genesis/* /avalon/blocks/* 2>/dev/null || true

echo "Starting Avalon node..."
cd /avalon
exec node --stack-size=65500 src/main
