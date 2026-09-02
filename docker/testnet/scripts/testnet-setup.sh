#!/bin/bash
# setup.sh - Initializes testnet miner accounts
set -euo pipefail

echo "=== Avalon Testnet - Setup ==="

BOOTSTRAP="${BOOTSTRAP_HOST:-bootstrap}"
API="http://${BOOTSTRAP}:${HTTP_PORT:-3001}"

# Wait for bootstrap node to be ready
echo "Waiting for bootstrap API at $API..."
for i in $(seq 1 60); do
    COUNT=$(curl -sf "$API/count" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).count))" 2>/dev/null || echo "")
    if [ -n "$COUNT" ] && [ "$COUNT" != "null" ]; then
        echo "Bootstrap ready at block #$COUNT"
        break
    fi
    sleep 2
done

# Wait for a few blocks so we can create accounts
echo "Waiting for blocks to accumulate..."
DEADLINE=$(( $(date +%s) + 120 ))
while [ $(date +%s) -lt $DEADLINE ]; do
    COUNT=$(curl -sf "$API/count" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).count))" 2>/dev/null || echo "0")
    if [ "$COUNT" -ge 5 ] 2>/dev/null; then
        echo "Enough blocks mined ($COUNT), starting account creation"
        break
    fi
    sleep 3
done
if [ "$COUNT" -lt 5 ] 2>/dev/null; then
    echo "TIMEOUT: waited 120s for 5 blocks, check chain health"
    exit 1
fi

# Run the setup script using the bootstrap's CLI (need node + src)
cd /avalon
node /avalon/scripts/setup-testnet.js

echo "=== Setup Complete ==="
