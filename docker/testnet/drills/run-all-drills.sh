#!/bin/bash
# Run the automated Layer S/H drill suite.
# Usage: run-all-drills.sh [--long]
#   --long  include G2, G3, G4 (jail / standby promotion, 10-15 min each)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LONG=false
if [ "${1:-}" = "--long" ]; then
    LONG=true
fi

FAST_DRILLS=(
    G1-one-leader-down-60-blocks.sh
    G5-network-partition.sh
    G7-equivocation.sh
    G8-force-finalize-asymmetric.sh
    G10-all-leaders-down.sh
    G11-halt-breaker-recovery.sh
    G9-old-node.sh
)

LONG_DRILLS=(
    G2-one-leader-jailed.sh
    G3-two-leaders-jailed.sh
    G4-standby-promotion.sh
)

PASSED=()
FAILED=()

run_one() {
    local script="$1"
    echo ""
    echo "============================================================"
    echo "Running $script"
    echo "============================================================"
    if bash "$script"; then
        PASSED+=("$script")
    else
        FAILED+=("$script")
        echo "[SUITE] $script FAILED"
    fi
}

for script in "${FAST_DRILLS[@]}"; do
    run_one "$script"
done

if [ "$LONG" = "true" ]; then
    for script in "${LONG_DRILLS[@]}"; do
        run_one "$script"
    done
else
    echo ""
    echo "Skipping long drills (G2, G3, G4). Use --long to include them."
fi

echo ""
echo "============================================================"
echo "Drill suite complete: ${#PASSED[@]} passed, ${#FAILED[@]} failed"
echo "============================================================"

if [ ${#PASSED[@]} -gt 0 ]; then
    echo "PASSED:"
    for s in "${PASSED[@]}"; do echo "  ✓ $s"; done
fi

if [ ${#FAILED[@]} -gt 0 ]; then
    echo "FAILED:"
    for s in "${FAILED[@]}"; do echo "  ✗ $s"; done
fi

echo ""

[ ${#FAILED[@]} -eq 0 ]
