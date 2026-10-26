#!/bin/bash
# testnet-jail-setup.sh — runs setup-jail.js against the bootstrap node
set -euo pipefail

echo "=== Avalon Jail Testnet - Setup ==="

BOOTSTRAP="${BOOTSTRAP_HOST:-bootstrap}"
API="http://${BOOTSTRAP}:${HTTP_PORT:-3001}"

echo "Waiting for bootstrap API at $API..."
for i in $(seq 1 60); do
    COUNT=$(curl -sf "$API/count" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).count))" 2>/dev/null || echo "")
    if [ -n "$COUNT" ] && [ "$COUNT" != "null" ]; then
        echo "Bootstrap ready at block #$COUNT"
        break
    fi
    sleep 2
done

DEADLINE=$(( $(date +%s) + 180 ))
while [ $(date +%s) -lt $DEADLINE ]; do
    COUNT=$(curl -sf "$API/count" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).count))" 2>/dev/null || echo "0")
    if [ "$COUNT" -ge 5 ] 2>/dev/null; then
        echo "Enough blocks mined ($COUNT), starting account creation"
        break
    fi
    sleep 3
done

cd /avalon
exec node scripts/setup-jail.js
