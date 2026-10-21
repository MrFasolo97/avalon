# Avalon Mainnet Deployment & Rollback Plan (No-Econs Migration)

**Target Release:** `v2.0.3` (branch `feat/auto-force-finalize`, tag `v2.0.3`)  
**Migration Type:** Code migration from `new_net` to no-economy codebase (fork #13330000 not activated)  
**Safety Level:** CRITICAL - Production Mainnet  
**Last Updated:** 2026-10-21

> ⚠️ **NEVER touch MongoDB directly during migration.** The chain state lives in MongoDB. Always use `mongodump`/`mongorestore` or filesystem snapshots of the Mongo volume.  
> ⚠️ **Tags are never moved.** Any superseding release gets a new tag.  
> ⚠️ **All nodes must run the same commit.** Version mismatch will cause network splits.

---

## Table of Contents

1. [Pre-Flight Checklist](#pre-flight-checklist)
2. [Backup Strategy (CRITICAL)](#backup-strategy-critical)
3. [P2P Catchup Fix (v2.0.3-hotfix)](#p2p-catchup-fix-v203-hotfix)
4. [Deployment Procedure](#deployment-procedure)
5. [Post-Deployment Verification](#post-deployment-verification)
6. [Rollback Procedure (Full Rollback)](#rollback-procedure-full-rollback)
7. [Emergency Procedures](#emergency-procedures)
8. [Appendix](#appendix)

---

## 1. Pre-Flight Checklist

### 1.1 Environment Requirements
- [ ] Node.js >= 24 (verified by `node --version`)
- [ ] Docker & Docker Compose installed
- [ ] MongoDB running and accessible
- [ ] Sufficient disk space for backups (at least 2x current DB size)
- [ ] All operators notified and available on cutover channel
- [ ] Maintenance window scheduled

### 1.2 Code Preparation
- [ ] Merge PR #2 (`feat/auto-force-finalize`) to target branch
- [ ] Tag released as `v2.0.3`
- [ ] Apply P2P catchup fixes if not already included (see section 3)
- [ ] Build Docker images for all node types
- [ ] Verify no `Hard Fork #13330000` references in logs/config
- [ ] Run static verification (see runbook S2)

### 1.3 Network State
- [ ] Record current block height: `curl -s localhost:3001/count`
- [ ] Check all leaders are online and syncing
- [ ] Verify no ongoing forks or consensus issues
- [ ] Document peer list for all nodes

---

## 2. Backup Strategy (CRITICAL)

**You MUST create these backups BEFORE making any changes.** Store them in a secure location with multiple copies.

### 2.1 MongoDB Full Backup (Primary Rollback Path)

This is the **most important backup**. The chain lives in MongoDB, not `blocks.bson`.

```bash
# Set backup directory with timestamp
BACKUP_DIR="/backup/avalon/$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR

# Full MongoDB dump (all databases)
mongodump --host <MONGO_HOST>:<MONGO_PORT> --out $BACKUP_DIR/mongodump

# Or if using Docker
docker exec <MONGO_CONTAINER> mongodump --archive --gzip > $BACKUP_DIR/mongo-full.archive.gz

# Verify backup
ls -lh $BACKUP_DIR/
mongorestore --dryRun --archive --gzip < $BACKUP_DIR/mongo-full.archive.gz 2>&1 | tail -5
```

### 2.2 Git Repository Backup

```bash
# In Avalon repo directory
cd /path/to/avalon
git fetch --all --tags
git log -1 --oneline > $BACKUP_DIR/git-commit.txt
git branch -a > $BACKUP_DIR/git-branches.txt
git describe --tags > $BACKUP_DIR/git-describe.txt

# Create a tarball of the repo state
tar czf $BACKUP_DIR/avalon-repo.tar.gz -C $(dirname $(pwd)) $(basename $(pwd))
```

### 2.3 Configuration Backup

```bash
# Backup all configs
cp config.js $BACKUP_DIR/config.js.backup 2>/dev/null
cp .env $BACKUP_DIR/.env.backup 2>/dev/null
cp -r docker/ $BACKUP_DIR/docker/ 2>/dev/null
cp -r scripts/ $BACKUP_DIR/scripts/ 2>/dev/null
```

### 2.4 Node State Snapshot (Optional but Recommended)

```bash
# For each node, snapshot state
for port in 3001 3002 3003; do
  curl -s localhost:$port/count > $BACKUP_DIR/count_port$port.txt
  curl -s localhost:$port/peers > $BACKUP_DIR/peers_port$port.txt
  curl -s localhost:$port/version > $BACKUP_DIR/version_port$port.txt
done
```

### 2.5 Backup Verification

```bash
# Verify Mongo dump is valid
gzip -t $BACKUP_DIR/mongo-full.archive.gz && echo "GZIP OK"

# Record backup location
echo "BACKUP_LOC=$BACKUP_DIR" >> /root/avalon-cutover-vars.sh
echo "BACKUP_HASH=$(sha256sum $BACKUP_DIR/mongo-full.archive.gz | awk '{print $1}')" >> /root/avalon-cutover-vars.sh
```

**CRITICAL:** Store `$BACKUP_DIR` location and hash securely. You'll need them for rollback.

---

## 3. P2P Catchup Fix (v2.0.3-hotfix)

As discovered in S4 dry-run, the new anti-DoS rate limiter can prevent stuck nodes from auto-recovering. Apply these fixes before deployment.

### 3.1 Apply Fixes to Source

Edit `src/p2p.js` with the following changes:

#### Fix A: Reset recovery state on disconnect when all peers lost
```javascript
closeConnection: (ws) => {
    const idx = p2p.sockets.indexOf(ws)
    if (idx !== -1)
        p2p.sockets.splice(idx, 1)
    logr.debug('a peer disconnected, '+p2p.sockets.length+' peers left')
    // If we were catching up and lost peers, reset recovery state so
    // p2p.refresh() can retry automatically instead of getting stuck.
    if (p2p.recovering) {
        if (p2p.sockets.length === 0) {
            logr.debug('Lost all peers while recovering, resetting recovery state')
            p2p.recovering = false
            p2p.recoveringBlocks = []
            p2p.recoveredBlocks = {}
        }
    }
},
```

#### Fix B: Pace recovery requests to avoid rate limiting
```javascript
recover: () => {
    if (!p2p.sockets || p2p.sockets.length === 0) return
    if (p2p._recoverTicking) return
    if (Object.keys(p2p.recoveredBlocks || {}).length + (p2p.recoveringBlocks || []).length > max_blocks_buffer) return
    if (!p2p.recovering) p2p.recovering = chain.getLatestBlock()._id
    
    let peersAhead = []
    for (let i = 0; i < p2p.sockets.length; i++)
        if (p2p.sockets[i].node_status 
        && p2p.sockets[i].node_status.head_block > chain.getLatestBlock()._id
        && p2p.sockets[i].node_status.origin_block === config.originHash)
            peersAhead.push(p2p.sockets[i])

    if (peersAhead.length === 0) {
        p2p.recovering = false
        return
    }

    secureShuffle(peersAhead)
    let champions = peersAhead.slice(0, Math.min(3, peersAhead.length))
    let champion = champions[0]
    if (p2p.recovering+1 <= champion.node_status.head_block) {
        p2p._recoverTicking = true
        const next = p2p.recovering + 1
        p2p.recovering = next
        // Space requests to avoid tripping the per-socket rate limit
        champions.forEach((ch, idx) => {
            setTimeout(() => {
                try { p2p.sendJSON(ch, {t: MessageType.QUERY_BLOCK, d: next}) } catch(e){}
            }, idx * 25)
        })
        if (!p2p.recoveringBlocks) p2p.recoveringBlocks = []
        if (!p2p.recoveredBlocks) p2p.recoveredBlocks = {}
        p2p.recoveringBlocks.push(next)
        logr.debug('query block #'+next+' -- head block: '+champion.node_status.head_block)
        setTimeout(() => {
            p2p._recoverTicking = false
            p2p.recover()
        }, 80)
    }
},
```

#### Fix C: More permissive rate limits during recovery
```javascript
ws.isRateLimited = (t) => {
    if (t !== MessageType.QUERY_BLOCK && t !== MessageType.NEW_BLOCK
        && t !== MessageType.BLOCK_CONF_ROUND && t !== MessageType.FORCE_FINALIZE)
        return false
    const now = Date.now()
    if (now - ws.msgWindow >= msg_rate_window) {
        ws.msgWindow = now
        ws.msgCount = 0
    }
    ws.msgCount++
    // During active catch-up, be more permissive
    let limit = msg_rate_max
    if (p2p.recovering && (t === MessageType.NEW_BLOCK)) {
        limit = 150
    } else if (p2p.recovering && t === MessageType.QUERY_BLOCK) {
        limit = 120
    } else if (p2p.recovering && t === MessageType.BLOCK) {
        limit = 150
    }
    if (ws.msgCount > limit) {
        logr.warn('P2P message rate limit exceeded, disconnecting peer')
        return true
    }
    return false
}
```

### 3.2 Test Fixes Locally First
```bash
# Test on local testnet before applying to mainnet
cd /tmp/opencode/avalon-s4
# Apply patches (done above)
docker restart avalon-testnet-bootstrap avalon-testnet-miner1 avalon-testnet-miner2 avalon-testnet-miner3
# Verify no rate limit kicks during normal operation
docker logs --tail 20 avalon-testnet-bootstrap | grep -c "rate limit exceeded"
```

---

## 4. Deployment Procedure

**Follow this exact order. Coordination is critical.**

### 4.1 Pre-Cutover (T-60 minutes)

```bash
# 1. Announce maintenance window
echo "[$(date)] Starting Avalon mainnet cutover preparation" | tee -a /var/log/avalon-cutover.log

# 2. Create all backups (Section 2)
source /root/avalon-cutover-vars.sh  # Will be created by backup script

# 3. Verify all nodes are healthy
for node in leader1 leader2 leader3 leader4; do
  ssh $node "curl -s localhost:3001/count && echo && curl -s localhost:3001/version"
done

# 4. Sync all nodes to same height
# Wait until all nodes report same count
```

### 4.2 Freeze (T-10 minutes) - CRITICAL

```bash
# STOP ALL LEADERS - coordinated in chat/voice
# NO NODE may remain on old code

for node in leader1 leader2 leader3 leader4; do
  ssh $node "systemctl stop avalon || pm2 stop avalon || docker stop avalon-node" &
done
wait

echo "[$(date)] All nodes stopped" | tee -a /var/log/avalon-cutover.log
```

### 4.3 Verify Halt State

```bash
# Check all nodes are stopped
for node in leader1 leader2 leader3 leader4; do
  ssh $node "ps aux | grep -E '[a]valon|[n]ode.*main' || echo 'STOPPED'"
done

# Verify MongoDB is still running
systemctl status mongod || docker ps | grep mongo
```

### 4.4 Deploy New Code

```bash
# On each node
for node in leader1 leader2 leader3 leader4; do
  ssh $node "cd /path/to/avalon && git fetch --all --tags && git checkout v2.0.3 && git log -1 --oneline && npm install && docker build -t avalon:\$(git rev-parse --short HEAD) . || true && docker-compose build || true"
done
```

### 4.5 Start New Version (T-0)

```bash
# Start ALL nodes with NEW code simultaneously
# Ensure same commit on all nodes

COMMIT=$(git rev-parse --short HEAD)
echo "[$(date)] Starting all nodes with commit $COMMIT" | tee -a /var/log/avalon-cutover.log

for node in leader1 leader2 leader3 leader4; do
  ssh $node "cd /path/to/avalon && export HTTP_HOST=0.0.0.0 && export CORS_ORIGIN='*' && export TRUST_PROXY=1 && export LOG_LEVEL=cons && nohup ./scripts/start.sh > /var/log/avalon.log 2>&1 & echo Started" &
done
wait

echo "[$(date)] All nodes started" | tee -a /var/log/avalon-cutover.log
```

### 4.6 Monitor Startup (T+0 to T+10 minutes)

```bash
# Watch logs for startup
for node in leader1 leader2 leader3 leader4; do
  ssh $node "tail -f /var/log/avalon.log" &
done

# Check for errors
sleep 60
grep -iE "error|fatal|exception" /var/log/avalon.log | tail -20
grep -c "Hard Fork #13330000" /var/log/avalon.log
```

---

## 5. Post-Deployment Verification

### 5.1 Critical Checks (Must Pass)

```bash
# 1. Version check - ALL nodes must report identical version
echo "=== VERSION CHECK ==="
for port in 3001 3002 3003 3004; do
  echo -n "Port $port: "
  curl -s localhost:$port/version
  echo
done
# Expected: {"version":"2.0.3"} on ALL nodes

# 2. Chain is advancing
echo "=== ADVANCEMENT CHECK ==="
for i in 1 2 3; do
  sleep 30
  for port in 3001 3002 3003 3004; do
    echo -n "Port $port: "
    curl -s localhost:$port/count
    echo
  done
  echo "---"
done
# Head must increase monotonically

# 3. No economy fork
echo "=== FORK CHECK ==="
grep -c "Hard Fork #13330000" /var/log/avalon.log
# Expected: 0

grep "Hard Fork #" /var/log/avalon.log | tail -5
# Only 241600 (and future scheduled forks) expected

# 4. Chain continuity
HEAD=$(curl -s localhost:3001/count | tr -d '"')
PREV=$(curl -s localhost:3001/block/$((HEAD-1)) | grep -o '"hash":"[^"]*"' | head -1)
CURR_PHASH=$(curl -s localhost:3001/block/$HEAD | grep -o '"phash":"[^"]*"' | head -1)
echo "Continuity: $PREV vs $CURR_PHASH"
# Must match

# 5. Supply sanity
curl -s localhost:3001/supply | head -c 100
echo
# Should respond normally (not economy-related)
```

### 5.2 Network Health

```bash
# Peer count
for port in 3001 3002 3003 3004; do
  echo -n "Port $port peers: "
  curl -s localhost:$port/peers | jq '. | length'
done
# Should have healthy peer connections

# Check for rate limit errors
grep -c "P2P message rate limit exceeded" /var/log/avalon.log
# Should be 0 or very low

# Check for recovery issues
grep "stuck\|recovery" /var/log/avalon.log | tail -10
```

### 5.3 Consensus Health

```bash
# Check for growing possBlocks (stuck consensus)
# This would indicate issues
grep "possBlocks" /var/log/avalon.log | tail -5

# Check force-finalize events (should be rare)
grep -c "Force finalizing" /var/log/avalon.log
grep -c "Block collision detected" /var/log/avalon.log
```

---

## 6. Rollback Procedure (Full Rollback)

**If anything goes wrong, follow this procedure to restore previous state.**

### 6.1 Decision to Rollback
Trigger rollback if:
- [ ] Nodes fail to start or crash repeatedly
- [ ] Chain stops advancing
- [ ] Fork detected (`Hard Fork #13330000` appears)
- [ ] Version mismatch across nodes
- [ ] Consensus stuck for >5 minutes
- [ ] Critical errors in logs

### 6.2 Immediate Actions (T+0 Rollback)

```bash
echo "[$(date)] INITIATING ROLLBACK" | tee -a /var/log/avalon-rollback.log

# 1. Stop all nodes immediately
for node in leader1 leader2 leader3 leader4; do
  ssh $node "systemctl stop avalon || pm2 stop avalon || docker stop avalon-node" &
done
wait
echo "[$(date)] All nodes stopped for rollback" | tee -a /var/log/avalon-rollback.log
```

### 6.3 Restore MongoDB from Backup

**This will completely restore chain state to pre-migration point.**

```bash
source /root/avalon-cutover-vars.sh

# Stop MongoDB
systemctl stop mongod || docker stop $MONGO_CONTAINER

# Backup current (failed) state just in case
mv /var/lib/mongodb /var/lib/mongodb.failed.$(date +%s)

# Restore from backup
if [ -f "$BACKUP_LOC/mongo-full.archive.gz" ]; then
  mongod --fork --logpath /var/log/mongod-restore.log
  mongorestore --archive --gzip --drop < $BACKUP_LOC/mongo-full.archive.gz
  echo "[$(date)] MongoDB restored" | tee -a /var/log/avalon-rollback.log
else
  # Try mongodump format
  mongorestore --drop --dir $BACKUP_LOC/mongodump
fi

# Restart MongoDB
systemctl restart mongod || docker start $MONGO_CONTAINER
sleep 10
```

### 6.4 Restore Code to Previous Version

```bash
for node in leader1 leader2 leader3 leader4; do
  ssh $node "cd /path/to/avalon && git fetch --all --tags && git checkout <PREVIOUS_COMMIT_OR_TAG>"
done
echo "[$(date)] Code restored to previous version" | tee -a /var/log/avalon-rollback.log
```

### 6.5 Restore Configurations

```bash
for node in leader1 leader2 leader3 leader4; do
  ssh $node "BACKUP_LOC=$BACKUP_LOC && cd /path/to/avalon && cp \$BACKUP_LOC/config.js.backup ./config.js 2>/dev/null && cp \$BACKUP_LOC/.env.backup ./.env 2>/dev/null"
done
```

### 6.6 Start Nodes with Restored Version

```bash
for node in leader1 leader2 leader3 leader4; do
  ssh $node "cd /path/to/avalon && export HTTP_HOST=0.0.0.0 && nohup ./scripts/start.sh > /var/log/avalon.log 2>&1 &" &
done
wait
echo "[$(date)] Nodes restarted with restored version" | tee -a /var/log/avalon-rollback.log
```

### 6.7 Verify Rollback Success

```bash
sleep 60

# Check versions match old version
for port in 3001 3002 3003 3004; do
  curl -s localhost:$port/version
done

# Check chain height matches backup
BACKUP_HEIGHT=$(cat $BACKUP_LOC/count_port3001.txt)
CURRENT_HEIGHT=$(curl -s localhost:3001/count)
echo "Backup height: $BACKUP_HEIGHT, Current: $CURRENT_HEIGHT"

# Verify chain is advancing again
sleep 60
curl -s localhost:3001/count

# Check for errors
grep -i "error\|fatal" /var/log/avalon.log | tail -10
```

### 6.8 Post-Rollback

- [ ] Announce rollback complete in channel
- [ ] Document reason for rollback in incident report
- [ ] Preserve failed state backups for analysis
- [ ] Do NOT delete rollback backups until root cause identified
- [ ] Schedule post-mortem

---

## 7. Emergency Procedures

### 7.1 Node Stuck in Recovery (P2P Rate Limit Issue)

If a node is stuck and not catching up:

```bash
# Try manual recovery endpoint
curl -s -H 'Accept: application/json' http://localhost:3001/recover
# Rate limited to 3/min per IP

# Check logs
tail -50 /var/log/avalon.log | grep -E "rate limit|recover|disconnect"

# If still stuck, restart node
systemctl restart avalon
```

**With the P2P fixes applied (section 3), this should happen automatically.**

### 7.2 MongoDB Corruption

```bash
# Stop node
systemctl stop avalon

# Check MongoDB integrity
mongod --dbpath /var/lib/mongodb --repair

# Or restore from backup if repair fails
# Follow rollback procedure section 6.3
```

### 7.3 Fork Detected

```bash
# IMMEDIATE FREEZE
systemctl stop avalon

# Check logs for fork info
grep -B5 -A30 "fork" /var/log/avalon.log | tail -50

# Do NOT restart until consensus with other operators
# May need to rollback or coordinate
```

---

## 8. Appendix

### 8.1 Useful Commands

```bash
# Check node status
curl -s localhost:3001/count
curl -s localhost:3001/version
curl -s localhost:3001/peers
curl -s localhost:3001/schedule

# Check logs
journalctl -u avalon -n 50
tail -f /var/log/avalon.log

# MongoDB checks
mongosh --eval "db.adminCommand({listDatabases:1})"
mongosh avalon --eval "db.blocks.countDocuments()"
mongosh avalon --eval "db.state.find({}).toArray()"

# Process management
ps aux | grep avalon
systemctl status avalon
pm2 status
docker ps
```

### 8.2 Contact Information

- **Lead Operator:** [Insert contact]
- **Backup Operator:** [Insert contact]
- **MongoDB Admin:** [Insert contact]
- **Emergency Channel:** [Insert channel]

### 8.3 Checklist Template

Copy this for each cutover:

```markdown
## Cutover Checklist - [DATE]

### Pre-Flight
- [ ] Backups created and verified
- [ ] All operators notified
- [ ] P2P fixes applied
- [ ] Tests passed on staging

### Cutover
- [ ] All nodes stopped (T-10)
- [ ] New code deployed (T-5)
- [ ] All nodes started (T-0)
- [ ] Monitoring active

### Verification
- [ ] All versions match
- [ ] Chain advancing
- [ ] No economy fork
- [ ] Peers connected
- [ ] No errors

### Sign-off
- [ ] Operator 1: _____
- [ ] Operator 2: _____
- [ ] Operator 3: _____
```

### 8.4 References

- [Migration Runbook (EN)](./migration-runbook-no-econs.en.md)
- [S4 Dry-Run Report](../../../../tmp/opencode/s4/S4-REPORT.md)
- [PR #2](https://github.com/dtube/avalon/pull/2)
- [Release v2.0.3](https://github.com/dtube/avalon/releases/tag/v2.0.3)

---

**Remember:** When in doubt, **rollback**. It's always safer to rollback than to guess. The backups you create are your only path to recovery.