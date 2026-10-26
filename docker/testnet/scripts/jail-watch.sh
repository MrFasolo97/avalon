#!/usr/bin/env bash
# jail-watch.sh — poll /leaderhealth and /count on all nodes
set -euo pipefail
PORTS=(3201 3202 3203 3204 3205)
NAMES=(bootstrap miner1 miner2 miner3 miner4)
for i in "${!PORTS[@]}"; do
    p=${PORTS[$i]}
    n=${NAMES[$i]}
    height=$(curl -s --max-time 2 "http://127.0.0.1:$p/count" | sed 's/.*count"://;s/}//' || echo "?")
    q=$(curl -s --max-time 2 "http://127.0.0.1:$p/leaderhealth" | python3 -c "import json,sys; d=json.load(sys.stdin); print('E='+str(d['quorum']['E'])+' q='+str(d['quorum']['q'])+' jailed='+str(len(d['jailed'])))" 2>/dev/null || echo "?")
    echo "$n:$p height=$height $q"
done
