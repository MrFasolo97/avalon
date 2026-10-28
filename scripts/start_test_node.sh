#!/bin/bash
# Start Avalon test node for integration testing
# Uses the existing MongoDB on the host, separate DB, different port

export HTTP_PORT=3029
export P2P_PORT=6029
export DB_NAME=avalon_2
export DB_URL=mongodb://localhost:27017
export NODE_OWNER=dtube
export NODE_OWNER_PUB=dTuBhkU6SUx9JEx1f4YEt34X9sC7QGso2dSrqE8eJyfz
export NODE_OWNER_PRIV=34EpMEDFJwKbxaF7FhhLyEe3AhpM4dwHMLVfs4JyRto5
export OFFLINE=1
export LOG_LEVEL=debug
export WARMUP_ACCOUNTS=0
export WARMUP_CONTENTS=0
export NO_DISCOVERY=1
export REPLAY_OUTPUT=0
export NODE_OPTIONS="--max-old-space-size=4096"
export MINE_TOKEN=test-mine-token-123
export DEBUG_TOKEN=test-debug-token-456

exec node --stack-size=65500 src/main.js "$@"
