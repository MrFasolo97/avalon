#!/bin/bash
# genesis.sh - Bootstrap node entrypoint for testnet
set -euo pipefail

echo "=== Avalon Testnet - Bootstrap Node ==="

DB_URL="${DB_URL:-mongodb://mongodb:27017}"
DB_NAME="${DB_NAME:-avalon}"

# Fresh testnet: drop stale data
cd /avalon
node -e "
const MongoClient = require('mongodb').MongoClient;
MongoClient.connect('${DB_URL}', {useNewUrlParser:true, useUnifiedTopology:true}, (e,c) => {
    if (e) { console.log('MongoDB connection:', e.message); process.exit(0); }
    c.db('${DB_NAME}').dropDatabase().then(() => { console.log('Dropped ${DB_NAME}'); c.close(); process.exit(0); });
});
" 2>&1 || true

rm -rf /avalon/genesis/* /avalon/blocks/* 2>/dev/null || true

# Patch config for testnet (replaces Dockerfile sed/patch-config that are lost when src is bind-mounted)
node -e "
const fs = require('fs');
let c = fs.readFileSync('/avalon/src/config.js', 'utf8');
c = c.replace(/masterDaoTxs: \[[^\]]*\]/, 'masterDaoTxs: [0,1,2,3,4,5,6,7,8,10,11,12,13,14,15,17,18,19,20,21,23,24,25,26,27,28,29,30,32]');
if (!c.includes('100:'))
  c = c.replace('241600: {', '100: {\\n            forceFinalize: true,\\n        },\\n        241600: {');
fs.writeFileSync('/avalon/src/config.js', c);
console.log('Patched config for testnet');
"

echo "Starting Avalon node..."
node --stack-size=65500 src/main &
AVALON_PID=$!

# Wait for API
echo "Waiting for API..."
for i in $(seq 1 30); do
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
    HEIGHT=$(curl -sf "http://localhost:3001/count" 2>/dev/null || echo "0")
    echo "Block height: $HEIGHT"
    if [ "$HEIGHT" -ge 5 ] 2>/dev/null; then
        echo "Chain is producing blocks autonomously"
        break
    fi
    curl -sf "http://localhost:3001/mineBlock" -o /dev/null 2>/dev/null || true
done

wait $AVALON_PID
