#!/bin/bash
# genesis.sh - Bootstrap node entrypoint for testnet
set -euo pipefail

echo "=== Avalon Testnet - Bootstrap Node ==="

# Fresh testnet: ensure no stale data in shared MongoDB via node driver
cd /avalon
node -e "
const MongoClient = require('mongodb').MongoClient;
const url = process.env.DB_URL || 'mongodb://localhost:27017';
const name = process.env.DB_NAME || 'avalon';
MongoClient.connect(url, {useNewUrlParser:true, useUnifiedTopology:true}, (e,c) => {
    if (e) { console.log('MongoDB connection:', e.message); process.exit(0); }
    c.db(name).dropDatabase().then(() => { console.log('Database dropped'); c.close(); process.exit(0); });
});
" 2>&1 || true

rm -rf /avalon/genesis/* /avalon/blocks/* 2>/dev/null || true

echo "Starting Avalon node (shared MongoDB: ${DB_URL}/${DB_NAME:-avalon})..."
exec node --stack-size=65500 src/main
