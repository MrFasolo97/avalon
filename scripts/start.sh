#!/bin/bash

# Ports configuration
#export HTTP_PORT=3001
#export P2P_PORT=6001
#export HTTP_HOST=0.0.0.0
#export P2P_HOST=0.0.0.0

# MongoDB configuration
#export DB_NAME=avalon
#export DB_URL=mongodb://localhost:27017

# Directory to folder containing blocks.bson file
#export BLOCKS_DIR=

# Peering configuration
#export OFFLINE=1
#export NO_DISCOVERY=1
#export DISCOVERY_EXCLUDE=dtube

# HTTP / API security (see doc/mainnet-deployment-and-rollback.md)
# CORS_ORIGIN unset = no CORS headers (browsers cannot read the API cross-origin)
#export CORS_ORIGIN='*'
# TRUST_PROXY: only set behind a reverse proxy, or all clients share one rate-limit bucket
#export TRUST_PROXY=1
# Admin endpoints (/mineBlock, /recover, /debug, /logs) FAIL CLOSED (401) without a token
#export ADMIN_TOKEN=
#export LOG_ADMIN_TOKEN=
# Local/dev only: allow token-less admin endpoints
#export ADMIN_ALLOW_ANONYMOUS=1
# Abuse limits
#export CONTENT_MAX_COMMENTS=2000
#export CONTENT_MAX_RESULTS=10000
#export IMG_MAX_BYTES=10485760
#export IMG_MAX_PIXELS=20000000

# Enable more modules
#export NOTIFICATIONS=1
#export RANKINGS=1
#export CONTENTS=1
#export LEADER_STATS=1
#export TX_HISTORY=1
#export PLAYLIST_JSON=1

# Cache warmup option
export WARMUP_ACCOUNTS=100000
export WARMUP_CONTENTS=0

# Warn when a transactions takes more than X ms
export WARN_SLOW_VALID=5
export WARN_SLOW_EXEC=5

# trace / perf / econ / cons / debug / info / warn
export LOG_LEVEL=info

# groups blocks during replay output to lower screen spam
export REPLAY_OUTPUT=10000

# Rebuild chain state from dump, verifying every block and transactions
# Do not forget to comment this out after rebuild
#export REBUILD_STATE=1
#export REBUILD_WRITE_INTERVAL=10000
#export REBUILD_NO_VALIDATE=1

# default peers to connect with on startup
export PEERS=
export MAX_PEERS=20

# your user and keys (only useful for active node owners)
export NODE_OWNER=dtube
export NODE_OWNER_PUB=dTuBhkU6SUx9JEx1f4YEt34X9sC7QGso2dSrqE8eJyfz
export NODE_OWNER_PRIV=34EpMEDFJwKbxaF7FhhLyEe3AhpM4dwHMLVfs4JyRto5

# Consensus — Layer S/H (see doc/mainnet-deployment-and-rollback.md)
# QC_SHADOW=1 enables the read-only vote-ledger observer (certifies, never refuses)
#export QC_SHADOW=1
# HALT_BREAKER=0 disables the halt-breaker recovery round on this node (liveness only)
#export HALT_BREAKER=0
# NOTE: the S1' gates singleVote / qcEnforce are CHAIN config (config.history), not
# env — a lone node flipping either would refuse its own votes and diverge. Set them
# (only) via the testnet config overlay; they stay off on mainnet.
#export VOTE_STATE_PATH=./state/vote_state.json
#export SCHEDULE_PERSIST_PATH=./state/schedule.json

# Memory limit for in-memory rebuild (in MB)
export NODE_OPTIONS=--max_old_space_size=8192

node --stack-size=65500 src/main
