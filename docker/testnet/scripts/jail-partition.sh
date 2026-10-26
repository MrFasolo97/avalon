#!/usr/bin/env bash
# jail-partition.sh — split the network into groups using iptables inside containers
set -euo pipefail
# Example: ./jail-partition.sh miner1,miner2 miner3,miner4
# Creates two partitions that cannot communicate with each other.
if [ $# -lt 2 ]; then
    echo "Usage: $0 <group1> <group2> [group3...]"
    echo "  groups are comma-separated container suffixes, e.g. miner1,miner2"
    exit 1
fi

declare -a ALL=()
declare -A GROUP_OF
idx=0
for g in "$@"; do
    IFS=',' read -ra NODES <<< "$g"
    for n in "${NODES[@]}"; do
        ALL+=("$n")
        GROUP_OF["$n"]=$idx
    done
    ((idx++)) || true
done

echo "[jail-partition] groups: $*"
for n in "${ALL[@]}"; do
    docker exec "avalon-jail-$n" iptables -F OUTPUT 2>/dev/null || true
    docker exec "avalon-jail-$n" iptables -F INPUT 2>/dev/null || true
done

# Drop traffic between different groups
for n in "${ALL[@]}"; do
    for m in "${ALL[@]}"; do
        [ "$n" = "$m" ] && continue
        if [ "${GROUP_OF[$n]}" != "${GROUP_OF[$m]}" ]; then
            docker exec "avalon-jail-$n" iptables -A OUTPUT -d "avalon-jail-$m" -j DROP 2>/dev/null || true
        fi
    done
done
echo "[jail-partition] done"
