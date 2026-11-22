// Release version, taken from package.json so it changes with the release. It is
// reported in NODE_STATUS (visible via /peers) so operators can run the flag-day
// version census (plan §8.2 gate 1). It used to be a hardcoded constant ('1.6.6')
// that never changed, which made the census unable to tell two releases apart.
// Informational only: no handshake rejects on it.
const version = require('../package.json').version
const default_port = 6001
const replay_interval = 1500
const discovery_interval = 60000
const keep_alive_interval = 2500
const max_blocks_buffer = 100
const max_peers = process.env.MAX_PEERS || 15
const max_recover_attempts = 25
// per-socket throttle for the message types that trigger expensive local work
// (block revalidation, disk reads, consensus rounds)
const msg_rate_window = 1000
const msg_rate_max = parseInt(process.env.P2P_MSG_RATE_MAX || '40', 10)
const history_interval = 10000
const keep_history_for = 20000
const p2p_port = process.env.P2P_PORT || default_port
const p2p_host = process.env.P2P_HOST || '::'
const WebSocket = require('ws')
const dns = require('dns').promises
const net = require('net')

// Fisher-Yates shuffle using crypto.randomInt (cryptographically secure)
function secureShuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
}
const crypto = require('crypto')
const { randomBytes } = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')(config.b58Alphabet)
const blocks = require('./blocks')
const dao = require('./dao')
const daoMaster = require('./daoMaster')
const events = require('./events')
const consensusQuorum = require('./consensusQuorum')
const divergence = require('./divergence')

const ff_amplify_seen = {}

setInterval(() => {
    const now = Date.now()
    for (const k in ff_amplify_seen)
        if (now - ff_amplify_seen[k] > 120000)
            delete ff_amplify_seen[k]
}, 60000)

const MessageType = {
    QUERY_NODE_STATUS: 0,
    NODE_STATUS: 1,
    QUERY_BLOCK: 2,
    BLOCK: 3,
    NEW_BLOCK: 4,
    NEW_TX: 5,
    BLOCK_CONF_ROUND: 6,
    FORCE_FINALIZE: 7,
    FF_FETCH: 8,
    FF_BLOCK: 9
}

let p2p = {
    sockets: [],
    bannedPeers: {},
    peerFailures: {},
    blockSenders: {},
    recoveringBlocks: [],
    recoveredBlocks: [],
    recovering: false,
    recoverAttempt: 0,
    lastDivergenceHeight: null,
    nodeId: null,
    // Highest height for which we hold a candidate block (finalised head or
    // in-flight possBlock). Advertised in NODE_STATUS so a node that just came
    // back online can see that someone already proposed the next height before
    // it mines from its stale local head (F8 fork fix). Old nodes ignore the
    // extra field, so this is wire-compatible in both directions.
    pendingHead: () => {
        let head = chain.getLatestBlock()._id
        const cands = consensus.possBlocks || []
        for (let i = 0; i < cands.length; i++)
            if (cands[i] && cands[i].block && cands[i].block._id > head)
                head = cands[i].block._id
        return head
    },
    init: () => {
        p2p.generateNodeId()
        let server = new WebSocket.Server({host:p2p_host, port: p2p_port, maxPayload: 10 * 1024 * 1024})
        server.on('connection', ws => p2p.handshake(ws))
        logr.info('Listening websocket p2p port on: ' + p2p_port)
        logr.info('Version:',version)
        setTimeout(() => {
            p2p.recover()
            setInterval(() => p2p.refresh(), replay_interval)
            // Keep the peers' head_block fresh: node_status is otherwise only
            // updated at handshake, so `refresh()`/recovery would compare against
            // a stale head and never notice a small (1-block) gap after a
            // partition heal. We reuse the socket's challenge hash as the random
            // so the reply verifies against the stored challenge.
            setInterval(() => p2p.refreshStatuses(), 5000)
        }, replay_interval)
        if (!process.env.NO_DISCOVERY || process.env.NO_DISCOVERY === '0' || process.env.NO_DISCOVERY === 0) {
            setInterval(function(){p2p.discoveryWorker()}, discovery_interval)
            p2p.discoveryWorker(true)
        }
        setInterval(function(){p2p.cleanRoundConfHistory()}, history_interval)
    },
    generateNodeId: () => {
        p2p.nodeId = chain.getNewKeyPair()
        logr.info('P2P ID: '+p2p.nodeId.pub)
    },
    discoveryWorker: (isInit = false) => {
        // Best-effort: discovery runs on an interval, so it must NEVER throw out
        // of it. A half-open socket (no _socket) or a malformed ws URL used to
        // throw here and kill discovery for good.
        try {
            let leaders = chain.generateLeaders(false, true, config.leaders*3, 0)
            const excluded = (process.env.DISCOVERY_EXCLUDE ? process.env.DISCOVERY_EXCLUDE.split(',') : [])
            for (let i = 0; i < leaders.length; i++) {
                if (p2p.sockets.length >= max_peers) {
                    logr.debug('We already have maximum peers: '+p2p.sockets.length+'/'+max_peers)
                    break
                }
                const leader = leaders[i]
                if (!leader.ws) continue
                if (excluded.indexOf(leader.name) > -1) continue

                // Validate the advertised endpoint before touching it.
                let leaderIp
                try {
                    const parsed = new URL(leader.ws)
                    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
                        continue
                    leaderIp = parsed.hostname
                } catch (error) {
                    logr.debug('Discovery: wrong ws for leader '+leader.name+' '+leader.ws)
                    continue
                }
                if (p2p.isBanned && p2p.isBanned(leaderIp)) {
                    logr.trace('Discovery: skipping banned '+leader.name+' ('+leaderIp+')')
                    continue
                }

                let isConnected = false
                for (let w = 0; w < p2p.sockets.length; w++) {
                    const sock = p2p.sockets[w]
                    // A half-open socket (network partition) has no _socket; this
                    // access used to throw and stop discovery.
                    if (!sock || !sock._socket || !sock._socket.remoteAddress) continue
                    let ip = sock._socket.remoteAddress
                    if (ip.indexOf('::ffff:') > -1)
                        ip = ip.replace('::ffff:', '')
                    if (leaderIp === ip) {
                        logr.trace('Already peered with '+leader.name)
                        isConnected = true
                        break
                    }
                }
                if (!isConnected) {
                    logr[isInit ? 'info' : 'debug']('Trying to connect to '+leader.name+' '+leader.ws)
                    p2p.connect([leader.ws], isInit)
                }
            }
        } catch (error) {
            logr.warn('discoveryWorker error (ignored): ' + error.message)
        }
    },
    keepAlive: async () => {
        // Ensure every peer explicitly listed in PEERS stays connected.
        //
        // This is a self-rescheduling async chain: it re-arms itself at the END
        // (see finally). Anything that threw in the middle used to break the
        // chain, and the node never reconnected to its PEERS again — which is
        // exactly what left miners with 0 peers after a full-cluster restart
        // (bootstrap included) and stalled the chain. Wrap the body so the chain
        // always survives, and reconnect on the next tick.
        try {
            let peers = process.env.PEERS ? process.env.PEERS.split(',') : []
            let toConnect = []
            for (let p = 0; p < peers.length; p++) {
                let connected = false
                let colonSplit = peers[p].replace(/^wss?:\/\//,'').split(':')
                let port = parseInt(colonSplit.pop())
                let address = colonSplit.join(':').replace('[','').replace(']','')
                let resolved = null
                if (!net.isIP(address))
                    try {
                        resolved = (await dns.lookup(address)).address
                    } catch (e) {
                        // Do NOT skip the peer on a transient DNS failure: without
                        // a resolved IP we cannot dedup, so attempt the connect
                        // anyway (the ws client re-resolves; if DNS is really down
                        // the attempt just fails harmlessly).
                        logr.debug('dns lookup failed for '+address)
                    }
                if (resolved)
                    for (let s = 0; s < p2p.sockets.length; s++) {
                        const sock = p2p.sockets[s]
                        // Only an OPEN, live socket counts as connected. A socket
                        // left behind by a network partition (half-open / already
                        // closing) has no `_socket` and used to match here anyway —
                        // which both threw and made keepAlive think the peer was
                        // still connected, so it never reconnected after
                        // `docker network disconnect`.
                        if (sock.readyState !== WebSocket.OPEN || !sock._socket) continue
                        if (sock._socket.remoteAddress
                        && sock._socket.remoteAddress.replace('::ffff:','') === resolved
                        && sock._socket.remotePort === port) {
                            connected = true
                            break
                        }
                    }
                if (!connected)
                    toConnect.push(peers[p])
            }
            p2p.connect(toConnect)
        } catch (e) {
            logr.warn('keepAlive error (ignored, retrying next tick): ' + e.message)
        } finally {
            setTimeout(p2p.keepAlive, keep_alive_interval)
        }
    },
    connect: (newPeers,isInit = false) => {
        newPeers.forEach((peer) => {
            let ws = new WebSocket(peer)
            ws.on('open', () => p2p.handshake(ws))
            ws.on('error', () => {
                logr[isInit ? 'warn' : 'debug']('peer connection failed', peer)
            })
        })
    },
    handshake: (ws) => {
        if (process.env.OFFLINE) {
            logr.warn('Incoming handshake refused because OFFLINE')
            ws.close(); return
        }
        if (p2p.sockets.length >= max_peers) {
            logr.warn('Incoming handshake refused because already peered enough '+p2p.sockets.length+'/'+max_peers)
            ws.close(); return
        }
        // refuse connection from banned peers
        let remoteIp = ws._socket.remoteAddress
        if (remoteIp.indexOf('::ffff:') > -1)
            remoteIp = remoteIp.replace('::ffff:', '')
        if (p2p.isBanned(remoteIp)) {
            logr.warn('Refused handshake from banned peer ' + remoteIp)
            ws.close(); return
        }
        // close connection if we already have this peer ip in our connected sockets
        for (let i = 0; i < p2p.sockets.length; i++)
            if (p2p.sockets[i]._socket.remoteAddress === ws._socket.remoteAddress
                && p2p.sockets[i]._socket.remotePort === ws._socket.remotePort) {
                ws.close()
                return
            }
        logr.debug('Handshaking new peer', ws.url || ws._socket.remoteAddress+':'+ws._socket.remotePort)
        let random = randomBytes(config.randomBytesLength).toString('hex')
        ws.challengeHash = random
        ws.lastStatusAt = Date.now()
        ws.pendingDisconnect = setTimeout(function() {
            for (let i = 0; i < p2p.sockets.length; i++)
                if (p2p.sockets[i].challengeHash === random) {
                    p2p.sockets[i].close()
                    logr.warn('A peer did not reply to NODE_STATUS')
                    continue
                }
        }, 1000)
        p2p.sockets.push(ws)
        p2p.messageHandler(ws)
        p2p.errorHandler(ws)
        p2p.sendJSON(ws, {
            t: MessageType.QUERY_NODE_STATUS,
            d: {
                nodeId: p2p.nodeId.pub,
                random: random
            }
        })
    },
    messageHandler: (ws) => {
        // Throttle cost-driving message types per socket. NODE_STATUS messages
        // (t 0/1) are excluded: they only carry the handshake and are cheap.
        ws.msgWindow = Date.now()
        ws.msgCount = 0
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
            if (ws.msgCount > msg_rate_max) {
                logr.warn('P2P message rate limit exceeded, disconnecting peer')
                return true
            }
            return false
        }
        ws.on('message', (data) => {
            let message
            try {
                message = JSON.parse(data)
            } catch(e) {
                logr.warn('P2P received non-JSON, doing nothing ;)')
            }
            if (!message || typeof message.t === 'undefined') return
            if (!message.d) return
            if (ws.isRateLimited(message.t)) return ws.close()
            // logr.debug('P2P-IN '+message.t)
            
            switch (message.t) {
            case MessageType.QUERY_NODE_STATUS:
                // a peer is requesting our node status
                if (typeof message.d !== 'object'
                || typeof message.d.nodeId !== 'string'
                || typeof message.d.random !== 'string')
                    return
                let wsNodeId = message.d.nodeId
                if (wsNodeId === p2p.nodeId.pub) {
                    logr.warn('Peer disconnected: same P2P ID')
                    ws.close()
                    return
                }

                // Preserve the rest of the recorded status: replacing it outright
                // dropped head_block/origin_block, so a periodic status probe left
                // the peer invisible to refresh()/recover() (no origin_block).
                let knownStatus = p2p.sockets[p2p.sockets.indexOf(ws)].node_status
                if (!knownStatus) knownStatus = {}
                knownStatus.nodeId = message.d.nodeId
                p2p.sockets[p2p.sockets.indexOf(ws)].node_status = knownStatus

                let sign = secp256k1.ecdsaSign(Buffer.from(message.d.random, 'hex'), bs58.decode(p2p.nodeId.priv))
                sign = bs58.encode(sign.signature)

                let d = {
                    origin_block: config.originHash,
                    head_block: chain.getLatestBlock()._id,
                    head_block_hash: chain.getLatestBlock().hash,
                    previous_block_hash: chain.getLatestBlock().phash,
                    pending_head: p2p.pendingHead(),
                    // Transferable PRECOMMIT proof for our head. Lets a diverged
                    // peer prove its branch has quorum votes (fork choice).
                    headVoteProof: consensus.getVoteProof
                        ? consensus.getVoteProof(chain.getLatestBlock()._id, chain.getLatestBlock().hash)
                        : [],
                    nodeId: p2p.nodeId.pub,
                    version: version,
                    sign: sign
                }
                p2p.sendJSON(ws, {t: MessageType.NODE_STATUS, d:d})
                break

            case MessageType.NODE_STATUS:
                // we received a peer node status
                if (typeof message.d !== 'object' || typeof message.d.sign !== 'string') break
                let nodeId = p2p.sockets[p2p.sockets.indexOf(ws)].node_status.nodeId
                if (!message.d.nodeId || message.d.nodeId !== nodeId)
                    return
                let challengeHash = p2p.sockets[p2p.sockets.indexOf(ws)].challengeHash
                if (!challengeHash)
                    return
                if (message.d.origin_block !== config.originHash) {
                    logr.debug('Different chain id, disconnecting')
                    return ws.close()
                }
                try {
                    let isValidSignature = secp256k1.ecdsaVerify(
                        bs58.decode(message.d.sign),
                        Buffer.from(challengeHash, 'hex'),
                        bs58.decode(nodeId))
                    if (!isValidSignature) {
                        logr.warn('Wrong NODE_STATUS signature, disconnecting')
                        ws.close()
                        return
                    }

                    for (let i = 0; i < p2p.sockets.length; i++)
                        if (i !== p2p.sockets.indexOf(ws)
                        && p2p.sockets[i].node_status
                        && p2p.sockets[i].node_status.nodeId === nodeId) {
                            logr.debug('Peer disconnected because duplicate connections')
                            p2p.sockets[i].close()
                        }

                    clearTimeout(p2p.sockets[p2p.sockets.indexOf(ws)].pendingDisconnect)
                    delete message.d.sign
                    p2p.sockets[p2p.sockets.indexOf(ws)].node_status = message.d
                    p2p.sockets[p2p.sockets.indexOf(ws)].lastStatusAt = Date.now()
                } catch (error) {
                    logr.error('Error during NODE_STATUS verification', error)
                }

                break

            case MessageType.QUERY_BLOCK:
                // a peer wants to see the data in one of our stored blocks
                const blockId = parseInt(message.d, 10)
                if (isNaN(blockId) || blockId < 0) break
                if (blocks.isOpen) {
                    let block = {}
                    try {
                        block = blocks.read(blockId)
                    } catch (e) {
                        break
                    }
                    p2p.sendJSON(ws, {t:MessageType.BLOCK, d:block})
                } else
                    db.collection('blocks').findOne({_id: blockId}, function(err, block) {
                        if (err)
                            throw err
                        if (block)
                            p2p.sendJSON(ws, {t:MessageType.BLOCK, d:block})
                    })
                break

            case MessageType.BLOCK:
                // a peer sends us a block we requested with QUERY_BLOCK
                if (!message.d._id || !p2p.recoveringBlocks.includes(message.d._id)) return
                for (let i = 0; i < p2p.recoveringBlocks.length; i++)
                    if (p2p.recoveringBlocks[i] === message.d._id) {
                        p2p.recoveringBlocks.splice(i, 1)
                        break
                    }
                            
                if (chain.getLatestBlock()._id+1 === message.d._id)
                    p2p.addRecursive(message.d)
                else {
                    p2p.recoveredBlocks[message.d._id] = message.d
                    p2p.recover()
                }
                break

            case MessageType.NEW_BLOCK:
                // we received a new block we didn't request from a peer
                // we save the head_block of our peers
                // and we forward the message to consensus if we are not replaying
                if (!message.d) return
                let block = message.d

                let socket = p2p.sockets[p2p.sockets.indexOf(ws)]
                if (!socket || !socket.node_status) return
                p2p.sockets[p2p.sockets.indexOf(ws)].node_status.head_block = block._id
                p2p.sockets[p2p.sockets.indexOf(ws)].node_status.head_block_hash = block.hash
                p2p.sockets[p2p.sockets.indexOf(ws)].node_status.previous_block_hash = block.phash

                // track which peer sent this block for failure banning
                if (block.hash)
                    p2p.blockSenders[block.hash] = { ws, ts: Date.now() }

                if (p2p.recovering) return
                consensus.round(0, block)
                break
                
            case MessageType.NEW_TX:
                // we received a new transaction from a peer
                if (p2p.recovering) return
                let tx = message.d

                // if the pool is already full, do nothing at all
                if (transaction.isPoolFull())
                    break

                // if its already in the mempool, it means we already handled it
                if (transaction.isInPool(tx))
                    break
                
                transaction.isValid(tx, new Date().getTime(), function(isValid) {
                    if (isValid) {
                        // if its valid we add it to mempool and broadcast it to our peers
                        transaction.addToPool([tx])
                        p2p.broadcast({t:5, d:tx})
                    } 
                    
                })
                break

            case MessageType.BLOCK_CONF_ROUND:
                // we are receiving a consensus round confirmation
                // it should come from one of the elected leaders, so let's verify signature
                if (p2p.recovering) return
                if (!message.s || !message.s.s || !message.s.n) return
                // Vote freshness: ±(consensusRounds+2)·blockTime instead of the old
                // ±2·blockTime (plan §5.4). Consensus votes are not block content, so a
                // wider window removes clock-skew-induced vote dropping without weakening
                // anti-replay, which is provided by the `processed` signature dedupe below
                // and by the per-(height, phase) distinct-signer counting.
                const voteWindow = (config.consensusRounds + 2) * config.blockTime
                if (!message.d || !Number.isFinite(message.d.ts) ||
                    !Number.isInteger(message.d.ts) || message.d.ts <= 0 ||
                    message.d.ts + voteWindow < new Date().getTime() ||
                    message.d.ts - voteWindow > new Date().getTime()) return

                logr.cons(message.s.n+' U-R'+message.d.r)

                if (p2p.sockets[p2p.sockets.indexOf(ws)]) {
                    if (!p2p.sockets[p2p.sockets.indexOf(ws)].sentUs)
                        p2p.sockets[p2p.sockets.indexOf(ws)].sentUs = []
                    p2p.sockets[p2p.sockets.indexOf(ws)].sentUs.push([message.s.s,new Date().getTime()])
                }

                const now = Date.now()
                const blockTime2x = 2 * config.blockTime
                consensus.processed = consensus.processed.filter(p => p[1] + blockTime2x >= now)
                for (let i = 0; i < consensus.processed.length; i++)
                    if (consensus.processed[i][0].s.s === message.s.s)
                        return
                consensus.processed.push([message, now])

                consensus.verifySignature(message, function(isValid) {
                    if (!isValid && !p2p.recovering) {
                        logr.warn('Received wrong consensus signature', message)
                        return
                    }

                    // bounce the message to peers
                    p2p.broadcastNotSent(message)

                    // always try to precommit in case its the first time we see it
                    consensus.round(0, message.d.b, function(validationStep) {
                        if (validationStep === -1) {
                            // logr.trace('Ignored BLOCK_CONF_ROUND')
                        } else if (validationStep === 0) {
                            // block is being validated, we queue the message
                            if (consensus.queue.length >= consensus.maxQueueSize)
                                logr.warn('Consensus queue at capacity, dropping message')
                            else
                                consensus.queue.push(message)
                            logr.debug('Added to queue')
                        } else
                            // process the message inside the consensus
                            consensus.remoteRoundConfirm(message)
                    })
                })
                break

            case MessageType.FORCE_FINALIZE:
                if (!message.s || !message.s.s || !message.s.n) break
                // Verify signature before any dedup to prevent unauthenticated poison
                consensus.verifySignature(message, function(isValid) {
                    if (!isValid) {
                        logr.warn('Received wrong FF signature from ' + message.s.n)
                        return
                    }
                    // Dedup by sender+signature to prevent broadcast amplification
                    const ffKey = message.s.n + '_' + message.s.s
                    const now = Date.now()
                    if (ff_amplify_seen[ffKey] && now - ff_amplify_seen[ffKey] < 120000) return
                    ff_amplify_seen[ffKey] = now
                    // Expire stale dedup entries
                    for (const kk in ff_amplify_seen)
                        if (Date.now() - ff_amplify_seen[kk] > 120000)
                            delete ff_amplify_seen[kk]
                    p2p.broadcastNotSent(message)
                    consensus.handleForceFinalizeProposal(message)
                })
                break

            case MessageType.FF_FETCH:
                // A peer needs a specific candidate block during force-finalize.
                // We only serve blocks we have locally; no signature required
                // (the block itself is signed and will be validated on arrival).
                if (typeof message.d !== 'object' || !Number.isInteger(message.d.height)) break
                const ffHashes = Array.isArray(message.d.hashes) ? message.d.hashes : [message.d.hash]
                for (const ffHash of ffHashes) {
                    if (typeof ffHash !== 'string') continue
                    const found = consensus.findPossBlockByHash && consensus.findPossBlockByHash(ffHash)
                    if (found) {
                        p2p.sendJSON(ws, { t: MessageType.FF_BLOCK, d: found.block })
                        continue
                    }
                    // Fall back to disk if we have it and it matches the height
                    if (!blocks.isOpen) continue
                    try {
                        const fromDisk = blocks.read(message.d.height)
                        if (fromDisk && fromDisk.hash === ffHash)
                            p2p.sendJSON(ws, { t: MessageType.FF_BLOCK, d: fromDisk })
                    } catch (e) {
                        // block not stored locally
                    }
                }
                break

            case MessageType.FF_BLOCK:
                // Received a candidate block requested via FF_FETCH. Treat it like
                // a NEW_BLOCK for the purpose of precommit / validation.
                if (!message.d || !message.d.hash) break
                if (p2p.recovering) {
                    // If we are recovering, queue it as a recovered block if the
                    // height is useful; otherwise let normal recovery handle it.
                    if (message.d._id > chain.getLatestBlock()._id)
                        p2p.recoveredBlocks[message.d._id] = message.d
                    break
                }
                if (message.d._id === chain.getLatestBlock()._id + 1)
                    consensus.round(0, message.d)
                break
            }
        })
    },
    recover: () => {
        if (!p2p.sockets || p2p.sockets.length === 0) return
        // Re-entrancy guard from the rate-limit resilience fix: `recover()`
        // re-schedules itself after the staggered QUERY_BLOCK batch, so a
        // second entry while a batch is in flight would queue duplicates.
        if (p2p._recoverTicking) return
        if (Object.keys(p2p.recoveredBlocks || {}).length + (p2p.recoveringBlocks || []).length > max_blocks_buffer) return
        if (!p2p.recovering) {
            p2p.recovering = chain.getLatestBlock()._id
            events.emit('recover-start', 'info', { head: p2p.recovering })
        }
        
        let peersAhead = []
        for (let i = 0; i < p2p.sockets.length; i++)
            if (p2p.sockets[i].node_status 
            && p2p.sockets[i].node_status.head_block > chain.getLatestBlock()._id
            && p2p.sockets[i].node_status.origin_block === config.originHash)
                peersAhead.push(p2p.sockets[i])

        if (peersAhead.length === 0) {
            if (p2p.recovering) {
                events.emit('recover-done', 'info', { head: chain.getLatestBlock()._id })
                // Let chain.js know a catch-up just finished so its minerWorker
                // can apply the stale-head grace period before proposing again.
                chain.markCatchUp()
            }
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
    refresh: (force = false) => {
        if (p2p.recovering && !force) return
        const head = chain.getLatestBlock()._id
        if (p2p.lastRefreshHead !== head) {
            p2p.lastRefreshHead = head
            p2p.headChangedAt = Date.now()
        }
        // A node whose head has not moved for a few block times is STALLED:
        // normal gossip would have advanced it. Only then is a small gap worth a
        // recovery. Previously recovery required a peer >10 blocks ahead, so a
        // node stuck 1 block behind (e.g. after a partition heal) never
        // recovered and the whole chain stayed frozen behind it.
        const stalled = (Date.now() - (p2p.headChangedAt || Date.now())) > 4 * config.blockTime
        for (let i = 0; i < p2p.sockets.length; i++)
            if (p2p.sockets[i].node_status
            && p2p.sockets[i].node_status.origin_block === config.originHash) {
                const ahead = p2p.sockets[i].node_status.head_block
                if (ahead > head + 10 || (ahead > head && stalled)) {
                    logr.info('Catching up with network, head block: ' + ahead
                        + (ahead > head + 10 ? '' : ' (local head stalled at ' + head + ')'))
                    p2p.recovering = head
                    p2p.recover()
                    break
                }
            }
    },
    // Ask every peer for a fresh NODE_STATUS so `node_status.head_block` is not a
    // stale handshake snapshot. The random is the socket's challenge hash, which
    // is exactly what the peer will sign, so the reply verifies.
    refreshStatuses: () => {
        const now = Date.now()
        for (let i = 0; i < p2p.sockets.length; i++) {
            const ws = p2p.sockets[i]
            if (!ws.challengeHash) continue
            // A socket whose peer has not answered a status probe for a while is
            // dead — typically a half-open TCP connection left behind by a
            // network partition. Its readyState stays OPEN, so keepAlive still
            // considers the peer connected and never reconnects. Close it so
            // closeConnection() removes it and keepAlive reconnects.
            if (ws.lastStatusAt && now - ws.lastStatusAt > 20000) {
                logr.warn('Peer did not answer status probes: closing a dead socket')
                ws.close()
                continue
            }
            p2p.sendJSON(ws, {
                t: MessageType.QUERY_NODE_STATUS,
                d: { nodeId: p2p.nodeId.pub, random: ws.challengeHash }
            })
        }
    },
    errorHandler: (ws) => {
        ws.on('close', () => p2p.closeConnection(ws))
        ws.on('error', () => p2p.closeConnection(ws))
    },
    closeConnection: (ws) => {
        const idx = p2p.sockets.indexOf(ws)
        if (idx !== -1)
            p2p.sockets.splice(idx, 1)
        logr.debug('a peer disconnected, '+p2p.sockets.length+' peers left')
        // If we were catching up and lost peers, reset recovery state so
        // p2p.refresh() can retry automatically instead of getting stuck.
        if (p2p.recovering && p2p.sockets.length === 0) {
            logr.debug('Lost all peers while recovering, resetting recovery state')
            p2p.recovering = false
            p2p.recoveringBlocks = []
            p2p.recoveredBlocks = {}
        }
    },
    recordBlockFailure: (blockHash) => {
        const entry = p2p.blockSenders[blockHash]
        delete p2p.blockSenders[blockHash]
        if (!entry || !entry.ws || !entry.ws._socket) return
        let ws = entry.ws
        let ip = ws._socket.remoteAddress
        if (ip.indexOf('::ffff:') > -1)
            ip = ip.replace('::ffff:', '')
        // cap peerFailures to prevent memory leak from IP cycling
        if (Object.keys(p2p.peerFailures).length >= 1000)
            return
        if (!p2p.peerFailures[ip])
            p2p.peerFailures[ip] = 0
        p2p.peerFailures[ip]++
        if (p2p.peerFailures[ip] >= 5) {
            const banSeconds = 300 // 5 minutes
            logr.warn('Banning peer ' + ip + ' for ' + banSeconds + 's (' + p2p.peerFailures[ip] + ' failures)')
            p2p.bannedPeers[ip] = Date.now() + banSeconds * 1000
            delete p2p.peerFailures[ip]
            ws.close()
        }
    },
    isBanned: (ip) => {
        if (!p2p.bannedPeers[ip]) return false
        if (Date.now() > p2p.bannedPeers[ip]) {
            delete p2p.bannedPeers[ip]
            return false
        }
        return true
    },
    sendJSON: (ws, d) => {
        try {
            let data = JSON.stringify(d)
            // logr.debug('P2P-OUT:', d.t)
            ws.send(data)
        } catch (error) {
            logr.warn('Tried sending p2p message and failed')
        }
        
    },
    broadcastNotSent: (d) => {
        firstLoop:
        for (let i = 0; i < p2p.sockets.length; i++) {
            if (!p2p.sockets[i].sentUs) {
                p2p.sendJSON(p2p.sockets[i], d)
                continue
            }
            for (let y = 0; y < p2p.sockets[i].sentUs.length; y++) 
                if (p2p.sockets[i].sentUs[y][0] === d.s.s)
                    continue firstLoop
            p2p.sendJSON(p2p.sockets[i], d)
        }
    },
    broadcast: (d) => p2p.sockets.forEach(ws => p2p.sendJSON(ws, d)),
    broadcastBlock: (block) => {
        p2p.broadcast({t:4,d:block})
    },
    // F8 automatic recovery: when the local branch is detected as divergent,
    // compare verifiable vote proofs and roll back to the common ancestor only
    // if a peer proves a stronger chain. Fail closed on missing proof/ancestor.
    maybeRollback: (conflict) => {
        if (process.env.AUTO_ROLLBACK === '0') return
        if (p2p._rollbackPending || !conflict || !Number.isInteger(conflict.height)) return
        const head = chain.getLatestBlock()
        if (!head || !head.hash) return
        const eligible = (consensus.eligibleLeaders && consensus.eligibleLeaders(head._id)) || []
        const quorum = consensusQuorum.blockQuorum(eligible.length, config.quorumMin || 3)
        const verify = (msg, cb) => consensus.verifySignature(msg, cb)
        const local = {
            height: head._id, hash: head.hash,
            proof: consensus.getVoteProof ? consensus.getVoteProof(head._id, head.hash) : []
        }
        const peers = (p2p.sockets || []).map(ws => ws.node_status).filter(s =>
            s && s.origin_block === config.originHash
            && Number.isInteger(s.head_block) && typeof s.head_block_hash === 'string'
        ).map(s => ({ height: s.head_block, hash: s.head_block_hash, proof: s.headVoteProof || [] }))

        const decision = divergence.evaluate({ local, peers, quorum, eligible, verifySignature: verify })
        if (!decision) return
        const localHashAt = (h) => {
            for (let i = chain.recentBlocks.length - 1; i >= 0; i--)
                if (chain.recentBlocks[i]._id === h) return chain.recentBlocks[i].hash
            try { return blocks.isOpen ? blocks.read(h).hash : null } catch (e) { return null }
        }
        const ancestor = divergence.findAncestor({
            height: conflict.height, phash: conflict.phash, localHashAt: localHashAt
        })
        if (ancestor === null) {
            logr.warn('CHAIN DIVERGENCE: proven peer found but no common ancestor within '
                + (process.env.MAX_REORG_DEPTH || 100) + ' blocks — refusing rollback')
            return
        }
        decision.ancestor = ancestor
        decision.fromHeight = head._id
        // Keep the txs of the orphaned tail so they can be re-offered to the
        // mempool AFTER the state has been rebuilt to the ancestor. Without
        // this, a minority node silently drops user txs that the majority may
        // still include in the canonical chain.
        decision.orphanTxs = []
        if (blocks.isOpen)
            for (let h = ancestor + 1; h <= head._id; h++)
                try {
                    const orphan = blocks.read(h)
                    if (orphan && Array.isArray(orphan.txs)) decision.orphanTxs.push(...orphan.txs)
                } catch (e) { /* a truncated/unreadable tail is already being discarded */ }
        p2p._rollbackPending = true
        events.emit('recover-start', 'info', { head: head._id, rollback: true })

        const mongo = require('./mongo')
        const voteState = require('./voteState')
        const txHistory = require('./txHistory')
        const leaderHealth = require('./leaderHealth')
        const leaderStats = require('./leaderStats')
        const transaction = require('./transaction')
        const deps = {
            logr, events,
            pause: () => {
                p2p.recovering = head._id
                if (chain.worker) clearTimeout(chain.worker)
                chain.workerPending = false
                cache.rollback()
            },
            truncateBlocks: (h) => blocks.isOpen ? blocks.truncate(h) : mongo.truncateBlocks(h),
            resetState: (h) => mongo.resetDerivedState(h),
            resetRuntime: () => {
                cache.clear()
                dao.resetID()
                daoMaster.resetID()
                voteState.reset()
                if (consensus.resetVoteProofs) consensus.resetVoteProofs()
                consensus.voteLedger = consensusQuorum.createLedger({ singleVote: true })
                // Derived RAM state from the discarded tail must not survive the
                // rebuild: stale anti-replay hashes are the worst offender, since
                // they make a resubmitted orphan tx look already used forever.
                chain.blocksToRebuild = []
                chain.recentBlocks = []
                chain.recentTxs = {}
                chain.schedule = {}
                chain.validating = []
                chain.processed = []
                chain.queue = []
                consensus.possBlocks = []
                consensus.heightSeen = {}
                consensus.commitRetry = {}
                consensus.finalizing = false
                consensus.cancelForceFinalize()
                txHistory.indexQueue = []
                leaderHealth.leaders = {}
                if (process.env.LEADER_STATS === '1' && leaderStats.reset) leaderStats.reset()
            },
            rebuildState: () => new Promise((rs, rj) => {
                chain.rebuildState(0, (e, builtTo) => e ? rj(e) : rs(builtTo))
            }),
            resume: (h) => {
                p2p.recovering = h
                p2p.recoverAttempt = 0
                p2p.recoveredBlocks = {}
                p2p.recoveringBlocks = []
                p2p.lastDivergenceHeight = null
                p2p._rollbackPending = false
                // Re-offer orphan txs only after the rebuilt state is back at the
                // ancestor, so validity/nonce checks run against the canonical
                // state rather than the one we just discarded.
                for (const tx of decision.orphanTxs || [])
                    try {
                        transaction.isValid(tx, Date.now(), (ok) => {
                            if (ok) transaction.addToPool([tx])
                        })
                    } catch (e) { logr.debug('Orphan tx not re-queued: ' + e.message) }
                setTimeout(() => p2p.recover(), 100)
            }
        }
        divergence.rollback(decision, deps).catch(e => {
            p2p._rollbackPending = false
            logr.error('CHAIN ROLLBACK failed: ' + e.message)
            events.emit('recover-giveup', 'error', { rollback: true, error: e.message })
        })
    },
    addRecursive: (block) => {
        chain.validateAndAddBlock(block, true, function(err, newBlock) {
            if (err) {
                // Divergence detection (F8): the fetched block does not extend our
                // chain — it is at/below our head, or it is head+1 but its parent
                // hash is not our head (a different chain). A forward-only recover
                // cannot heal this; surface it as a loud event/log so an operator
                // sees it instead of an endless "invalid phash" loop. Detection
                // only: recover still tries other peers.
                const head = chain.getLatestBlock()
                const bid = block && block._id
                if (Number.isInteger(bid)) {
                    const phashMismatch = bid === head._id + 1 && block.phash && block.phash !== head.hash
                    const alreadyHave = bid <= head._id
                    if ((phashMismatch || alreadyHave) && p2p.lastDivergenceHeight !== bid) {
                        p2p.lastDivergenceHeight = bid
                        events.emit('chain-divergence', 'error', {
                            head: head._id, ourHash: head.hash, blockHeight: bid,
                            blockHash: block.hash, blockPhash: block.phash
                        })
                        logr.error('CHAIN DIVERGENCE suspected at #' + bid + ' (our head #'
                            + head._id + '): fetched block does not extend our chain')
                        p2p.maybeRollback({ height: bid, phash: block.phash, hash: block.hash })
                        // The rollback owns state/reset/recovery from here; the
                        // normal "try another peer" path must not race with it.
                        if (p2p._rollbackPending) return
                    }
                }
                // try another peer if bad block
                cache.rollback()
                dao.resetID()
                daoMaster.resetID()
                p2p.recoveredBlocks = []
                p2p.recoveringBlocks = []
                p2p.recoverAttempt++
                if (p2p.recoverAttempt > max_recover_attempts) {
                    logr.error('Error Replay', newBlock._id)
                    events.emit('recover-giveup', 'error', { block: newBlock._id, attempts: p2p.recoverAttempt })
                    p2p.recovering = false
                    p2p.recoverAttempt = 0
                    // A giveup must not be permanent: a halted node that later
                    // regains a healthy peer set (leaders restarted, quorum
                    // restored) has to keep trying. Re-arm a bounded retry so the
                    // operator still sees the giveup but the node is not stranded
                    // forever after "Error Replay".
                    if (p2p.recoverRetryTimeout) clearTimeout(p2p.recoverRetryTimeout)
                    p2p.recoverRetryTimeout = setTimeout(function() {
                        p2p.recoverRetryTimeout = null
                        p2p.recovering = chain.getLatestBlock()._id
                        p2p.recover()
                    }, 30000)
                }
                else {
                    logr.warn('Recover attempt #'+p2p.recoverAttempt+' for block '+newBlock._id)
                    p2p.recovering = chain.getLatestBlock()._id
                    p2p.recover()
                }
            } else {
                p2p.recoverAttempt = 0
                delete p2p.recoveredBlocks[newBlock._id]
                p2p.recover()
                if (p2p.recoveredBlocks[chain.getLatestBlock()._id+1]) 
                    setTimeout(function() {
                        if (p2p.recoveredBlocks[chain.getLatestBlock()._id+1])
                            p2p.addRecursive(p2p.recoveredBlocks[chain.getLatestBlock()._id+1])
                    }, 1)
            }     
        })
    },
    cleanRoundConfHistory: () => {
        logr.trace('Cleaning old p2p messages history')
        for (let i = 0; i < p2p.sockets.length; i++) {
            if (!p2p.sockets[i].sentUs)
                continue
            for (let y = 0; y < p2p.sockets[i].sentUs.length; y++)
                if (new Date().getTime() - p2p.sockets[i].sentUs[y][1] > keep_history_for) {
                    p2p.sockets[i].sentUs.splice(y,1)
                    y--
                }
        }
        // clean stale blockSenders entries (older than 2 minutes)
        const now = Date.now()
        Object.keys(p2p.blockSenders).forEach(hash => {
            if (now - p2p.blockSenders[hash].ts > 120000)
                delete p2p.blockSenders[hash]
        })
        // cap total size to bound memory under hostile block bursts
        const maxBlockSenders = 10000
        const keys = Object.keys(p2p.blockSenders)
        if (keys.length > maxBlockSenders) {
            const sorted = keys.sort((a,b) => p2p.blockSenders[a].ts - p2p.blockSenders[b].ts)
            for (let i = 0; i < sorted.length - maxBlockSenders; i++)
                delete p2p.blockSenders[sorted[i]]
        }
    }
}

module.exports = p2p
