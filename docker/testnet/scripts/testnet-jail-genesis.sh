#!/bin/bash
# testnet-jail-genesis.sh — bootstrap node for the offline-leader (jail) testnet.
#
# Same as testnet-genesis.sh but WITHOUT the runtime patch of src/config.js:
# this testnet keeps masterDaoTxs and forceFinalize at their mainnet values and
# configures the jail / quorum parameters through environment variables instead.
set -euo pipefail

echo "=== Avalon Jail Testnet - Bootstrap Node ==="

DB_URL="${DB_URL:-mongodb://mongodb:27017}"
DB_NAME="${DB_NAME:-avalon}"

cd /avalon

# Fresh testnet: drop stale data
node -e "
const MongoClient = require('mongodb').MongoClient;
MongoClient.connect('${DB_URL}', {useNewUrlParser:true, useUnifiedTopology:true}, (e,c) => {
    if (e) { console.log('MongoDB connection:', e.message); process.exit(0); }
    c.db('${DB_NAME}').dropDatabase().then(() => { console.log('Dropped ${DB_NAME}'); c.close(); process.exit(0); });
});
" 2>&1 || true

rm -rf /avalon/genesis/* /avalon/blocks/* 2>/dev/null || true

node --stack-size=65500 src/main &
AVALON_PID=$!

for i in $(seq 1 60); do
    if curl -sf "http://localhost:3001/count" &>/dev/null; then
        echo "API ready"
        break
    fi
    sleep 2
done

# Kickstart mining: call /mineBlock until blocks start flowing
echo "Kickstarting block production..."
for i in $(seq 1 20); do
    sleep 3
    HEIGHT=$(curl -sf "http://localhost:3001/count" 2>/dev/null | grep -oP '"count":\K\d+' || echo "0")
    echo "Block height: $HEIGHT"
    if [ "$HEIGHT" -ge 5 ] 2>/dev/null; then
        echo "Chain is producing blocks autonomously"
        break
    fi
    curl -sf "http://localhost:3001/mineBlock" -o /dev/null 2>/dev/null || true
done

wait $AVALON_PID
