#!/bin/bash
# Launch the full Layer S/H drill suite inside a detached screen session.
# Everything (build, testnet start, drills, logs) runs inside the screen.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="avalon-drills"
RUNNER="$SCRIPT_DIR/screen-runner.sh"

# Kill any existing session with the same name
screen -S "$SESSION" -X quit 2>/dev/null || true

# Start a new detached screen running the full pipeline
screen -dmS "$SESSION" bash "$RUNNER"

echo "Drill suite launched in screen session '$SESSION'."
echo ""
echo "Attach with:  screen -r $SESSION"
echo "Detach with:  Ctrl+A then D"
echo "Tail log:     tail -f /tmp/avalon-drills-run-*.log"
