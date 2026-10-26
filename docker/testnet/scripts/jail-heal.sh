#!/usr/bin/env bash
# jail-heal.sh — remove all iptables partition rules
set -euo pipefail
NODES=(bootstrap miner1 miner2 miner3 miner4)
for n in "${NODES[@]}"; do
    docker exec "avalon-jail-$n" iptables -F OUTPUT 2>/dev/null || true
    docker exec "avalon-jail-$n" iptables -F INPUT 2>/dev/null || true
done
echo "[jail-heal] partitions removed"
