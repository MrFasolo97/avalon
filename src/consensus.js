const secp256k1 = require('secp256k1')
const crypto = require('crypto')
const bs58 = require('base-x')(config.b58Alphabet)
const cloneDeep = require('clone-deep')
const leaderHealth = require('./leaderHealth')
const commitLockStore = require('./commitLockStore')
// The 2/3 rule is now expressed by the adaptive quorum (plan §6.3):
// q = min(quorumCap, max(quorumMin, E)) — see src/leaderHealth.js

// all p2p.sockets referenced here are verified nodes with a node_status

const FF_BACKOFF_MS = [600, 1200, 2400, 4800]

let consensus = {
    observer: false,
    validating: [],
    processed: [],
    queue: [],
    maxQueueSize: 5000,
    finalizing: false,
    forceFinalizeTimeout: null,
    ffProposals: null,
    ffResolveTimeout: null,
    haltBreakerTimeout: null,
    haltBreakerHeight: 0,
    breaker: null,
    _degradedState: { since: 0, consecutive: 0, lastHeight: -1 },
    // per-height commit lock: at most one hash per height is committed by this node
    // (see leaderHealth.commitDecision). `breakerOverride` is set for one height by a
    // haltBreaker recovery round and is the only way to commit a second hash.
    // The lock is persisted so a crash + restart cannot cause double-signing.
    commitLocks: {},
    loadCommitLocks: () => {
        consensus.commitLocks = commitLockStore.load()
    },
    breakerOverride: null,
    lockRefusals: 0,
    lockOverrides: 0,
    possBlocks: [],
    getActiveLeaderKey: (name) => {
        let shuffle = chain.schedule.shuffle
        for (let i = 0; i < shuffle.length; i++)
            if (shuffle[i].name === name)
                return shuffle[i].pub_leader
        return
    },
    isActive: () => {
        if (consensus.observer)
            return false
        let thPub = consensus.getActiveLeaderKey(process.env.NODE_OWNER)
        if (!thPub) {
            logr.info(process.env.NODE_OWNER+' is not elected, defaulting to observer')
            consensus.observer = true
            return false
        }
        if (process.env.NODE_OWNER_PUB !== thPub) {
            consensus.observer = true
            logr.warn('Leader key does not match blockchain data, observing instead',thPub, process.env.NODE_OWNER_PUB)
            return false
        }
        return true
    },
    activeLeaders: () => {
        // the real active leaders are those who can mine or backup this block
        // i.e. a new leader only enters consensus on the block he gets scheduled for
        // and out of consensus 2*config.leaders blocks after his last scheduled block
        let blockNum = chain.getLatestBlock()._id+1
        let actives = []
        if (!chain.schedule.shuffle || chain.schedule.shuffle.length === 0)
            return actives
        let currentLeader = chain.schedule.shuffle[(blockNum-1)%config.leaders].name
        if (consensus.getActiveLeaderKey(currentLeader))
            actives.push(currentLeader)

        for (let i = 1; i < 2*config.leaders; i++)
            if (chain.recentBlocks[chain.recentBlocks.length-i]
            && actives.indexOf(chain.recentBlocks[chain.recentBlocks.length-i].miner) === -1
            && consensus.getActiveLeaderKey(chain.recentBlocks[chain.recentBlocks.length-i].miner))
                actives.push(chain.recentBlocks[chain.recentBlocks.length-i].miner)
        
        // logr.cons('Leaders: ' + actives.join(','))
        return actives
    },
    // --- offline-leader plan (prototype): adaptive quorum + halt breaker ---

    // Eligible leaders for the quorum (plan §6.3): the current rotation, minus the
    // leaders that are jailed or whose most recent scheduled turn was proven skipped
    // on-chain. Purely chain-derived, so every node computes the same E.
    leaderQuorum: () => {
        const names = []
        const schedule = chain.schedule
        if (schedule && schedule.shuffle)
            for (let i = 0; i < schedule.shuffle.length; i++) {
                const s = schedule.shuffle[i]
                if (s && s.name && names.indexOf(s.name) === -1) names.push(s.name)
            }
        const height = chain.getLatestBlock()._id + 1
        return leaderHealth.quorumFor(names, chain.jailState(height),
            height, chain.healthParams(height))
    },
    quorumThreshold: () => consensus.leaderQuorum().q,
    scheduleHaltBreaker: () => {
        if (!config.haltBreaker || consensus.finalizing) return
        const height = chain.getLatestBlock()._id + 1
        if (!consensus.possBlocks.some(pb => pb.block._id === height)) return
        if (consensus.haltBreakerTimeout && consensus.haltBreakerHeight === height) return
        if (consensus.haltBreakerTimeout) clearTimeout(consensus.haltBreakerTimeout)
        consensus.haltBreakerHeight = height
        const delay = Math.max(1000, config.haltBreakerMs)
        consensus.haltBreakerTimeout = setTimeout(() => {
            consensus.haltBreakerTimeout = null
            consensus._haltBreaker(height)
        }, delay)
        if (consensus.haltBreakerTimeout.unref) consensus.haltBreakerTimeout.unref()
        logr.debug('haltBreaker armed for height ' + height + ' in ' + delay + 'ms')
    },
    cancelHaltBreaker: () => {
        if (consensus.haltBreakerTimeout) clearTimeout(consensus.haltBreakerTimeout)
        consensus.haltBreakerTimeout = null
        consensus.breaker = null
        consensus.breakerOverride = null
    },
    // Recovery round (plan §6.3.1): the ONLY wall-clock element of the design. It
    // only changes *when* this node accepts an already produced block, never which
    // block is valid. The breaker requires a *majority* of the eligible signers so
    // that, together with the per-height commit lock, two conflicting blocks at the
    // same height cannot both be finalised under a partition.
    _haltBreaker: (height) => {
        if (!config.haltBreaker || consensus.finalizing) return
        if (height !== chain.getLatestBlock()._id + 1) return
        const candidates = consensus.possBlocks.filter(pb => pb.block._id === height)
        if (candidates.length === 0) return
        candidates.sort((a, b) => {
            if (a.block.timestamp !== b.block.timestamp)
                return a.block.timestamp - b.block.timestamp
            return a.block.hash < b.block.hash ? -1 : 1
        })
        const winner = candidates[0]
        const q = consensus.leaderQuorum()
        const signers = (winner[0] || []).filter(n => q.eligible.indexOf(n) !== -1)
        const recovery = leaderHealth.breakerRecovery(q.eligible.length, signers.length)
        if (!recovery.allowed) {
            logr.warn('haltBreaker: recovery not possible at height ' + height +
                ' (' + recovery.reason + ', signers=' + signers.length + '/' + q.eligible.length +
                ' need>=' + recovery.threshold + ' missing=' + recovery.missing +
                '/max ' + recovery.maxMissing + '), halting instead of forking')
            return
        }
        logr.warn('haltBreaker: recovery round at height ' + height + ' with ' +
            signers.length + '/' + q.eligible.length + ' eligible signers (q=' + q.q +
            ', ' + recovery.reason + '), block by ' + winner.block.miner)
        // the recovery round is wall-clock and may outlast blockTime: re-anchor the
        // next mining ladder on this instant (see chain.minerWorker)
        chain.scheduleAnchor = Date.now()
        // the only sanctioned way to commit a second hash at the same height: the
        // breaker winner is chosen by the same deterministic rule on every node
        consensus.breakerOverride = { height: height, hash: winner.block.hash }
        consensus.breaker = { height, threshold: signers.length }
        consensus.tryNextStep()
    },
    tryNextStepBusy: false,
    tryNextStep: () => {
        if (consensus.finalizing || consensus.tryNextStepBusy) {
            setTimeout(() => consensus.tryNextStep(), 100)
            return
        }
        consensus.tryNextStepBusy = true
        try {
            // adaptive quorum (plan §6.3): q = min(quorumCap, max(quorumMin, E)),
            // E = chain-derived eligible leaders (jailed / proven-skipped excluded)
            let threshold = consensus.quorumThreshold()

            // halt breaker recovery round (plan §6.3.1): if the eligible set is stale
            // (a leader died before any skip could be recorded) the requirement is
            // lowered to the live eligible signers already observed
            if (consensus.breaker && consensus.breaker.height === chain.getLatestBlock()._id + 1)
                threshold = Math.min(threshold, consensus.breaker.threshold)

            // Degraded mode observability
            try {
                const qq = consensus.leaderQuorum()
                const hh = chain.getLatestBlock()._id + 1
                const hhealth = chain.healthParams(hh)
                if (hhealth.jailEnabled && qq.E < hhealth.quorumMin) {
                    if (!consensus._degradedState) consensus._degradedState = { since: 0, consecutive: 0, lastHeight: -1 }
                    if (consensus._degradedState.lastHeight !== hh) {
                        if (consensus._degradedState.since === 0 || consensus._degradedState.lastHeight !== hh - 1) {
                            consensus._degradedState.since = hh
                            consensus._degradedState.consecutive = 1
                        } else {
                            consensus._degradedState.consecutive++
                        }
                        consensus._degradedState.lastHeight = hh
                        logr.warn('DEGRADED MODE: E=' + qq.E + ' < quorumMin=' + hhealth.quorumMin + ', q=' + qq.q + ', eligible=' + JSON.stringify(qq.eligible) + ', consecutive=' + consensus._degradedState.consecutive)
                        if (consensus._degradedState.consecutive >= 100) {
                            logr.error('CRITICAL: chain in degraded mode for ' + consensus._degradedState.consecutive + ' consecutive blocks since height ' + consensus._degradedState.since)
                        }
                    }
                } else if (consensus._degradedState && consensus._degradedState.consecutive > 0) {
                    logr.info('Degraded mode ended')
                    consensus._degradedState = { since: 0, consecutive: 0, lastHeight: -1 }
                }
            } catch (e) {}

            // if we are observing, we need +1 to pass consensus as we want to manage our own rounds
            if (!consensus.isActive())
                threshold += 1

            // identify block collisions between blocks of same _id produced by:
            // 1. only one leader (double production)
            // 2. more than one leader (latency issues between leaders)
            // resolution: apply the earliest valid block, or in case of same timestamp the lowest hash
            // todo: add leader slashing for double production and other possible malicious behaviour
            let possBlocksById = {}
            if (consensus.possBlocks.length > 1) {
                for (let i = 0; i < consensus.possBlocks.length; i++) 
                    if (possBlocksById[consensus.possBlocks[i].block._id])
                        possBlocksById[consensus.possBlocks[i].block._id].push(consensus.possBlocks[i])
                    else
                        possBlocksById[consensus.possBlocks[i].block._id] = [consensus.possBlocks[i]]
            
                consensus.possBlocks.sort((a,b) => {
                // valid blocks with different _id must have a different timestamp
                    if (a.block.timestamp !== b.block.timestamp)
                        return a.block.timestamp - b.block.timestamp
                    else
                        return a.block.hash < b.block.hash ? -1 : 1
                })
            }

            // Canonical selection per height (fix fork from asymmetric views):
            // determine the canonical block for the next height by earliest timestamp, then lowest hash.
            // Only the canonical block can be finalized; all other candidates for the same height are ignored
            // regardless of whether they reached quorum. This ensures all nodes converge on the same block.
            const nextHeight = chain.getLatestBlock()._id + 1
            let canonicalByHeight = {}
            for (const hid of Object.keys(possBlocksById)) {
                const hNum = Number(hid)
                if (hNum !== nextHeight) continue
                const candidates = possBlocksById[hid]
                if (candidates.length === 0) continue
                let best = candidates[0]
                for (let k = 1; k < candidates.length; k++) {
                    const c = candidates[k]
                    if (c.block.timestamp < best.block.timestamp ||
                        (c.block.timestamp === best.block.timestamp && c.block.hash < best.block.hash)) {
                        best = c
                    }
                }
                canonicalByHeight[hNum] = best.block.hash
            }

            for (let i = 0; i < consensus.possBlocks.length; i++) {
                const possBlock = consensus.possBlocks[i]
                logr.cons('T'+Math.ceil(threshold)+' R0-'+(possBlock[0]?possBlock[0].length:'?')+' R1-'+(possBlock[1]?possBlock[1].length:'?'))
                // Only finalize the canonical block for the next height; ignore non-canonical candidates
                if (possBlock.block._id === nextHeight && canonicalByHeight[nextHeight] && canonicalByHeight[nextHeight] !== possBlock.block.hash) {
                    continue
                }
                // if 2/3+ of the final round and not already finalizing another block
                if (possBlock[config.consensusRounds-1].length >= threshold 
            && !consensus.finalizing 
            && possBlock.block._id === nextHeight
            && possBlock[0] && possBlock[0].indexOf(process.env.NODE_OWNER) !== -1) {
                // per-height commit lock: do not finalise a second block at this height
                if (config.commitLock) {
                    const decision = leaderHealth.commitDecision(
                        consensus.commitLocks, possBlock.block._id, possBlock.block, consensus.breakerOverride)
                    if (!decision.allow) {
                        consensus.lockRefusals++
                        logr.warn('commit lock: refusing to finalise block ' + possBlock.block._id +
                            '#' + String(possBlock.block.hash).substr(0, 8) + ' by ' + possBlock.block.miner +
                            ', already committed ' + String(decision.lockedHash || '').substr(0, 8))
                        continue
                    }
                    if (decision.overridden) {
                        consensus.lockOverrides++
                        logr.warn('commit lock: override by haltBreaker at height ' + possBlock.block._id +
                            '#' + String(possBlock.block.hash).substr(0, 8) + ' by ' + possBlock.block.miner)
                    }
                    if (decision.lock) {
                        consensus.commitLocks[possBlock.block._id] = { hash: possBlock.block.hash, miner: possBlock.block.miner }
                        commitLockStore.append(possBlock.block._id, possBlock.block.hash, possBlock.block.miner)
                    }
                }
                // block becomes valid, we can move forward !
                    consensus.finalizing = true

                    // log which block got applied if collision exists
                    if (possBlocksById[possBlock.block._id] && possBlocksById[possBlock.block._id].length > 1) {
                        let collisions = []
                        let collisionBlocks = possBlocksById[possBlock.block._id]
                        for (let j = 0; j < collisionBlocks.length; j++)
                            collisions.push([collisionBlocks[j].block.miner, collisionBlocks[j].block.timestamp])
                        logr.info('Block collision detected at height '+possBlock.block._id+', the leaders are:',collisions)
                        logr.cons('Poss blocks',possBlocksById[possBlock.block._id])
                        logr.info('Applying block '+possBlock.block._id+'#'+possBlock.block.hash.substr(0,4)+' by '+possBlock.block.miner+' with timestamp '+possBlock.block.timestamp)
                    } else
                        logr.cons('block '+possBlock.block._id+'#'+possBlock.block.hash.substr(0,4)+' got finalized')

                    chain.validateAndAddBlock(possBlock.block, false, function(err) {
                        try {
                            if (err) {
                                logr.error('Consensus block validation failed for '+possBlock.block._id+'#'+possBlock.block.hash.substr(0,8)+' by '+possBlock.block.miner, err)
                                cache.rollback()
                                dao.resetID()
                                daoMaster.resetID()
                                consensus.possBlocks = consensus.possBlocks.filter(pb => pb.block.hash !== possBlock.block.hash)
                                consensus.finalizing = false
                                return
                            }

                            // clean up old possible blocks
                            let newPossBlocks = []
                            for (let y = 0; y < consensus.possBlocks.length; y++) 
                                if (possBlock.block._id < consensus.possBlocks[y].block._id)
                                    newPossBlocks.push(consensus.possBlocks[y])
                    
                            consensus.possBlocks = newPossBlocks
                            consensus.finalizing = false
                            consensus.cancelHaltBreaker()
                            // drop the commit locks of blocks that are now final
                            for (const h of Object.keys(consensus.commitLocks))
                                if (Number(h) <= possBlock.block._id)
                                    delete consensus.commitLocks[h]
                            commitLockStore.cleanup(possBlock.block._id)
                            if (config.forceFinalize)
                                consensus.cancelForceFinalize()
                        } catch (e) {
                            logr.error('Unhandled error in validateAndAddBlock callback', e)
                            consensus.finalizing = false
                        }
                    })
                }
                // if 2/3+ of any previous round, we try to commit it again
                else for (let y = 0; y < config.consensusRounds-1; y++)
                    if (possBlock[y].length >= threshold)
                        consensus.round(y+1, possBlock.block) 
            }
        } finally {
            consensus.tryNextStepBusy = false
        }
    },
    round: (round, block, cb) => {
        // ignore for different block height
        if (block._id && block._id !== chain.getLatestBlock()._id+1) {
            if (cb) cb(-1)
            return
        }

        // or the already added block hash
        if (block.hash === chain.getLatestBlock().hash) {
            if (cb) cb(-1)
            return
        }

        if (round === 0) {
            // precommit stage

            // skip whatever we already validated
            for (let i = 0; i < consensus.possBlocks.length; i++)
                if (consensus.possBlocks[i].block.hash === block.hash) {
                    if (cb) cb(1)
                    return
                }

            // or are currently validating
            if (consensus.validating.indexOf(block.hash) > -1) {
                if (cb) cb(0)
                return
            }

            if (Object.keys(block).length === 1 && block.hash) {
                if (cb) cb(0)
                return
            }
                
            // Canonical precommit (fix): only precommit the canonical candidate for this height
            // before validation completes. We compute canonical from all candidates we already know
            // about plus this candidate.
            if (block._id && block._id === chain.getLatestBlock()._id + 1) {
                let candidatesForPrecommit = []
                for (let c = 0; c < consensus.possBlocks.length; c++) {
                    if (consensus.possBlocks[c].block._id === block._id)
                        candidatesForPrecommit.push(consensus.possBlocks[c].block)
                }
                candidatesForPrecommit.push(block)
                candidatesForPrecommit.sort((a,b) => {
                    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
                    return a.hash < b.hash ? -1 : (a.hash > b.hash ? 1 : 0)
                })
                const canonicalPreHash = candidatesForPrecommit[0].hash
                if (canonicalPreHash !== block.hash) {
                    // Don't precommit non-canonical candidates; still validate/store but don't sign round 0
                    // We'll wait for the canonical candidate to be propagated
                    logr.cons('Non-canonical block received for height '+block._id+'#'+block.hash.substr(0,4)+' by '+block.miner+', waiting for canonical')
                }
            }
                
            consensus.validating.push(block.hash)

            // its a new possible block, set up the empty possible block
            let possBlock = {
                block:block
            }
            for (let r = 0; r < config.consensusRounds; r++)
                possBlock[r] = []

            // now we verify the block is valid
            logr.cons('New poss block '+block._id+'/'+block.miner+'/'+block.hash.substr(0,4))
            chain.isValidNewBlock(block, true, true, function(isValid) {
                consensus.validating.splice(consensus.validating.indexOf(possBlock.block.hash), 1)
                if (!isValid) {
                    if (block.hash && p2p && p2p.recordBlockFailure)
                        p2p.recordBlockFailure(block.hash)
                    logr.error('Received invalid new block from '+block.miner, block.hash)
                    if (cb) cb(-1)
                } else {
                    // adding to possible blocks
                    if (consensus.possBlocks.length >= consensus.activeLeaders().length * 2)
                        logr.warn('possBlocks at capacity, not adding new block')
                    else
                        consensus.possBlocks.push(possBlock)
                    if (config.forceFinalize)
                        consensus.scheduleForceFinalize()
                    // adding ourselves to precommit list only for canonical block (or if we mined it)
                    for (let i = 0; i < consensus.possBlocks.length; i++) 
                        if (block.hash === consensus.possBlocks[i].block.hash
                        && consensus.possBlocks[i][0].indexOf(process.env.NODE_OWNER) === -1) {
                            // Compute canonical for this height
                            let cands = []
                            for (let c = 0; c < consensus.possBlocks.length; c++) {
                                if (consensus.possBlocks[c].block._id === block._id)
                                    cands.push(consensus.possBlocks[c].block)
                            }
                            cands.sort((a,b) => {
                                if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
                                return a.hash < b.hash ? -1 : (a.hash > b.hash ? 1 : 0)
                            })
                            const canon = cands.length ? cands[0].hash : block.hash
                            if (canon === block.hash || block.miner === process.env.NODE_OWNER) {
                                possBlock[0].push(process.env.NODE_OWNER)
                                logr.cons('Precommitting block '+block._id+'#'+block.hash.substr(0,4))
                            } else {
                                logr.cons('Holding off precommit for non-canonical block '+block._id+'#'+block.hash.substr(0,4)+' by '+block.miner)
                            }
                        }

                    // processing queued messages for this block
                    for (let i = 0; i < consensus.queue.length; i++) {
                        const msg = consensus.queue[i]
                        if (!msg || !msg.d || !msg.d.b || !msg.d.b.hash) {
                            consensus.queue.splice(i, 1)
                            i--
                            continue
                        }
                        if (msg.d.b.hash === possBlock.block.hash) {
                            // logr.warn('From Queue: '+msg.d.b.hash)
                            consensus.remoteRoundConfirm(msg)
                            consensus.queue.splice(i, 1)
                            i--
                            continue
                        }
                        if (msg.d.ts + 2*config.blockTime < new Date().getTime()) {
                            consensus.queue.splice(i, 1)
                            i--
                        }
                    }

                    // and broadcasting the precommit to our peers
                    consensus.endRound(round, block)

                    if (cb) cb(1)
                }
            })
        } else {
            // commit stage: a node signs round 1 on every candidate whose round 0
            // reached threshold. The actual per-height lock is acquired later, in
            // tryNextStep, when a block is finalised; locking here would risk locking
            // a losing candidate and then refusing the winner.
            for (let b = 0; b < consensus.possBlocks.length; b++)
                if (consensus.possBlocks[b].block.hash === block.hash
                && consensus.possBlocks[b][round].indexOf(process.env.NODE_OWNER) === -1) {
                    consensus.possBlocks[b][round].push(process.env.NODE_OWNER)
                    consensus.endRound(round, block)
                }
        }
    },
    endRound: (round, block) => {
        if (consensus.isActive()) {
            // signing and broadcast to our peers
            // only if we are an active leader
            let onlyBlockHash = {
                hash: block.hash
            }
            if (block.miner === process.env.NODE_OWNER && round === 0)
                onlyBlockHash = block
            let signed = consensus.signMessage({t:6, d:{r:round, b: onlyBlockHash, ts: new Date().getTime()}})
            p2p.broadcast(signed)
        }

        // try to move to next consensus step
        consensus.scheduleHaltBreaker()
        consensus.tryNextStep()
    },
    remoteRoundConfirm: (message) => {
        let block = message.d.b
        let round = message.d.r
        let leader = message.s.n

        // Validate round as integer within configured consensus range
        if (typeof round !== 'number' || round !== Math.floor(round) || round < 0 || round >= config.consensusRounds)
            return
        
        for (let i = 0; i < consensus.possBlocks.length; i++) 
            if (block.hash === consensus.possBlocks[i].block.hash) {
                if (!consensus.possBlocks[i][round] || consensus.possBlocks[i][round].indexOf(leader) !== -1)
                    break
                
                // Add the leader only to the round they actually confirmed
                if (consensus.possBlocks[i][round])
                    consensus.possBlocks[i][round].push(leader)
                
                consensus.tryNextStep()
                break
            }       
    },
    signMessage: (message) => {
        let sigVersion = config.consensusSigVersion || 1
        let serialized
        if (sigVersion === 2)
            serialized = JSON.stringify(Object.keys(message).sort().reduce((o, k) => { o[k] = message[k]; return o }, {}))
        else
            serialized = JSON.stringify(message)
        let hash = crypto.createHash('sha256').update(serialized).digest('hex')
        let signature = secp256k1.ecdsaSign(Buffer.from(hash, 'hex'), bs58.decode(process.env.NODE_OWNER_PRIV))
        signature = bs58.encode(signature.signature)
        message.s = {
            n: process.env.NODE_OWNER,
            s: signature,
            v: sigVersion
        }
        return message
    },
    handleForceFinalizeProposal: (message) => {
        if (!consensus.ffProposals) return
        const sender = message.s && message.s.n
        if (!sender || !consensus.getActiveLeaderKey(sender)) return
        const actives = consensus.activeLeaders()
        if (actives.indexOf(sender) === -1) return
        if (message.d.height !== consensus.ffProposals.height) return

        // Determine which hash this sender is voting for
        let hash = message.d.hash
        if (!hash && Array.isArray(message.d.hashes)) {
            // Pick best local match from the sender's candidate list
            const local = consensus.possBlocks.filter(pb =>
                pb.block._id === message.d.height
                && message.d.hashes.indexOf(pb.block.hash) !== -1
            )
            local.sort((a, b) => {
                if (a.block.timestamp !== b.block.timestamp)
                    return a.block.timestamp - b.block.timestamp
                return a.block.hash < b.block.hash ? -1 : 1
            })
            hash = local[0] && local[0].block.hash
        }
        if (!hash) return

        // Only accept votes for blocks we actually have locally
        if (!consensus.ffProposals.proposals[hash]) 
            for (let i = 0; i < consensus.possBlocks.length; i++) {
                const pb = consensus.possBlocks[i]
                if (pb.block.hash === hash && pb.block._id === message.d.height) {
                    consensus.ffProposals.proposals[hash] = pb
                    break
                }
            }
        
        if (!consensus.ffProposals.proposals[hash]) return

        // Track this respondent
        if (consensus.ffProposals.respondents[sender] !== hash) {
            consensus.ffProposals.respondents[sender] = hash
            logr.cons('FF respondent: ' + sender + ' for ' + message.d.height + '#' + hash.substr(0, 8))
        }

        // Re-broadcast the proposal to accelerate convergence
        if (p2p && p2p.broadcastNotSent)
            p2p.broadcastNotSent(message)
    },
    cancelForceFinalize: (safe) => {
        // don't null ffProposals if a resolve is in-flight — let it complete
        if (safe && consensus.finalizing) return
        clearTimeout(consensus.forceFinalizeTimeout)
        consensus.forceFinalizeTimeout = null
        if (consensus.ffResolveTimeout) {
            clearTimeout(consensus.ffResolveTimeout)
            consensus.ffResolveTimeout = null
        }
        if (!safe) consensus.ffProposals = null
    },
    scheduleForceFinalize: () => {
        const latestBlock = chain.getLatestBlock()
        const expectedHeight = latestBlock._id + 1
        // skip if timer already set for this height (don't reset = don't delay)
        if (consensus.forceFinalizeTimeout || consensus.finalizing) return
        const hasCandidate = consensus.possBlocks.some(pb => pb.block._id === expectedHeight)
        if (!hasCandidate) return

        const fromNow = Math.max(1000,
            latestBlock.timestamp + config.blockTime * (config.leaders + config.consensusRounds + 2) - Date.now()
        )

        if (fromNow > 86400000) {
            logr.warn('Force finalize scheduled too far in the future (' + fromNow + 'ms) for height ' + expectedHeight + ', skipping')
            return
        }

        logr.debug('Force finalize scheduled in ' + fromNow + 'ms for height ' + expectedHeight)

        consensus.forceFinalizeTimeout = setTimeout(() => {
            consensus._forceFinalize(expectedHeight)
        }, fromNow)

        if (consensus.forceFinalizeTimeout.unref)
            consensus.forceFinalizeTimeout.unref()
    },
    _getQuorumThreshold: () => {
        const activeCount = Math.max(1, consensus.activeLeaders().length)
        const configThreshold = Math.ceil(config.leaders * 2 / 3)
        const activeThreshold = Math.ceil(activeCount * 2 / 3)
        // Require at least 3 respondents so no 50% partition can force-finalize
        return Math.min(configThreshold, Math.max(activeThreshold, 3))
    },
    _forceFinalize: (height, candidateRetry) => {
        consensus.forceFinalizeTimeout = null
        if (consensus.finalizing) return
        if (!config.forceFinalize) return
        if (height !== chain.getLatestBlock()._id + 1) return

        if (candidateRetry === undefined) candidateRetry = 0
        if (candidateRetry >= 3) {
            logr.fatal('Force finalize: retry limit exceeded for height ' + height)
            consensus.finalizing = false
            return
        }

        let candidates = consensus.possBlocks.filter(pb => pb.block._id === height)
        if (candidates.length === 0) {
            logr.warn('Force finalize has no candidates for height ' + height)
            consensus.finalizing = false
            return
        }

        candidates.sort((a, b) => {
            if (a.block.timestamp !== b.block.timestamp)
                return a.block.timestamp - b.block.timestamp
            return a.block.hash.localeCompare(b.block.hash)
        })

        const winner = candidates[0]

        if (candidates.length > 1) {
            let details = candidates.map(c => [
                c.block.miner,
                c.block._id + '#' + (c.block.hash || '??').substr(0, 8),
                c.block.timestamp,
                (c.block.hash || '??').substr(0, 8)
            ])
            logr.info('Block collision timeout at height ' + height + ', forced selection:', details)
        }

        if (candidates.length > 1) {
            const winnerHash = (winner.block.hash || '??').substr(0, 8)
            logr.warn('Force finalizing block ' + height + '#' + winnerHash + ' by ' + winner.block.miner + ' — selected locally without consensus, fork risk if peers diverge')
        }

        // Lock finalizing before ffProposals/broadcast so tryNextStep can't race
        // and finalize a different block while we're in the anti-fork protocol.
        consensus.finalizing = true

        // Anti-fork: broadcast ALL candidates to peers and collect responses before committing
        // Dedup: skip if we already have an in-flight proposal at the same height
        if (consensus.ffProposals && consensus.ffProposals.height === height) {
            consensus.finalizing = false
            return
        }
        const ownName = process.env.NODE_OWNER
        const candidateHashes = candidates.map(c => c.block.hash)
        consensus.ffProposals = { height, proposals: {}, respondents: {} }
        candidates.forEach(c => { consensus.ffProposals.proposals[c.block.hash] = c })
        if (consensus.getActiveLeaderKey(ownName))
            consensus.ffProposals.respondents[ownName] = winner.block.hash

        if (p2p && p2p.broadcast) {
            const proposal = consensus.signMessage({
                t: 7,
                d: { height, hashes: candidateHashes, timestamp: winner.block.timestamp }
            })
            p2p.broadcast(proposal)
        }
        consensus._resolveForceFinalize(height, candidateRetry, 0)
    },
    _resolveForceFinalize: (height, candidateRetry, ffAttempt) => {
        consensus.ffResolveTimeout = null
        if (!consensus.ffProposals) {
            logr.warn('FF resolve: ffProposals cleared without finalization at height ' + height + ', rescheduling')
            consensus.finalizing = false
            const retryTimer = setTimeout(() => consensus.scheduleForceFinalize(), 5000)
            if (retryTimer.unref) retryTimer.unref()
            return
        }

        const allCandidates = Object.values(consensus.ffProposals.proposals)
        if (allCandidates.length === 0) {
            logr.error('FF resolve: no proposals for height ' + height)
            consensus.ffProposals = null
            consensus.finalizing = false
            return
        }
        allCandidates.sort((a, b) => {
            if (a.block.timestamp !== b.block.timestamp)
                return a.block.timestamp - b.block.timestamp
            return a.block.hash.localeCompare(b.block.hash)
        })

        const activeLeadersCount = consensus.activeLeaders().length
        const quorumThreshold = consensus._getQuorumThreshold()
        const respondents = consensus.ffProposals.respondents
        const respondentCount = Object.keys(respondents).length

        // Count votes per hash among respondents
        const hashVotes = {}
        for (const hash of Object.values(respondents)) 
            hashVotes[hash] = (hashVotes[hash] || 0) + 1
        

        const bestHash = Object.keys(hashVotes).length > 0
            ? Object.keys(hashVotes).reduce((a, b) => hashVotes[a] > hashVotes[b] ? a : b)
            : allCandidates[0].block.hash
        const bestVotes = bestHash ? (hashVotes[bestHash] || 0) : 0
        const hasQuorum = bestVotes >= quorumThreshold

        const respondentsByHash = {}
        for (const [name, hash] of Object.entries(respondents))
            (respondentsByHash[hash] = respondentsByHash[hash] || []).push(name)

        if (hasQuorum) 
            logr.cons('FF quorum reached: ' + bestVotes + '/' + quorumThreshold + ' for ' + height + '#' + bestHash.substr(0, 8))
        else {
            const totalLeaders = activeLeadersCount || respondents.length
            logr.cons('FF quorum not met: ' + bestVotes + '/' + quorumThreshold + ' (' + respondentCount + '/' + totalLeaders + ' respondents)')
        }

        // Find the block for bestHash
        const bestBlock = allCandidates.find(c => c.block.hash === bestHash)
        if (!bestBlock) 
            logr.error('FF resolve: best hash ' + bestHash.substr(0, 8) + ' not found among candidates, using local winner')
        

        if (hasQuorum) {
            if (bestBlock && bestBlock.block.hash !== allCandidates[0].block.hash) 
                logr.info('Anti-fork: quorum selected ' + height + '#' + bestBlock.block.hash.substr(0, 8) + ' by ' + bestBlock.block.miner + ' (local was ' + allCandidates[0].block.miner + ')')
            
            consensus.ffProposals = null
            consensus._applyForceFinalize(height, bestBlock || allCandidates[0], candidateRetry)
            return
        }

        const maxAttempts = FF_BACKOFF_MS.length
        if (ffAttempt + 1 < maxAttempts) {
            const delay = FF_BACKOFF_MS[ffAttempt + 1]
            logr.cons('FF retry ' + (ffAttempt + 1) + '/' + maxAttempts + ' in ' + delay + 'ms for height ' + height)

            // Reset respondents for fresh round — preserve existing votes to prevent vote replay
            const prevRespondents = {}
            if (consensus.ffProposals && consensus.ffProposals.respondents)
                Object.assign(prevRespondents, consensus.ffProposals.respondents)
            consensus.ffProposals.respondents = prevRespondents

            // Re-broadcast proposal in case peers missed it
            if (p2p && p2p.broadcast) {
                const winner = allCandidates[0]
                const proposal = consensus.signMessage({
                    t: 7,
                    d: { height, hashes: allCandidates.map(c => c.block.hash), timestamp: winner.block.timestamp }
                })
                p2p.broadcast(proposal)
            }

            consensus.ffResolveTimeout = setTimeout(() => {
                consensus._resolveForceFinalize(height, candidateRetry, ffAttempt + 1)
            }, delay)
            if (consensus.ffResolveTimeout && consensus.ffResolveTimeout.unref)
                consensus.ffResolveTimeout.unref()
        } else {
            if (!config.forceFinalizeFallback) {
                logr.fatal('FF backoff exhausted and fallback disabled — chain halts at height ' + height + '. Quorum: ' + bestVotes + '/' + quorumThreshold + '. Retrying in 10s...')
                consensus.ffProposals = null
                consensus.finalizing = false
                const retryTimer = setTimeout(() => consensus.scheduleForceFinalize(), 10000)
                if (retryTimer.unref) retryTimer.unref()
                return
            }
            const collisionRisk = Object.keys(hashVotes).length > 1
            if (collisionRisk) 
                logr.fatal('FF backoff exhausted with ' + Object.keys(hashVotes).length + ' conflicting hashes for height ' + height + '. FORK RISK. Respondents:', respondentsByHash)
            else 
                logr.warn('FF backoff exhausted without quorum for height ' + height + ' (' + respondentCount + '/' + quorumThreshold + ' respondents). Proceeding with best candidate.')
            
            consensus.ffProposals = null
            consensus._applyForceFinalize(height, bestBlock || allCandidates[0], candidateRetry)
        }
    },
    _applyForceFinalize: (height, winner, retryCount) => {
        if (!winner || !winner.block) {
            logr.error('Force finalize has no valid winner for height ' + height + ', skipping')
            consensus.finalizing = false
            return
        }
        chain.validateAndAddBlock(winner.block, true, function(err) {
            if (err) {
                const blockHash = (winner && winner.block && winner.block.hash) || 'unknown'
                logr.error('Force finalize failed for ' + height + '#' + blockHash.substr(0, 8), err)
                consensus.possBlocks = consensus.possBlocks.filter(pb => pb.block.hash !== blockHash)
                const remaining = consensus.possBlocks.filter(pb => pb.block._id === height)
                if (remaining.length > 0 && retryCount < 3) {
                    logr.warn('Trying next candidate for height ' + height + ' (retry ' + (retryCount + 1) + '/3)')
                    setImmediate(() => {
                        consensus.finalizing = false
                        consensus._forceFinalize(height, retryCount + 1)
                    })
                    return
                }
                if (remaining.length > 0) 
                    logr.fatal('Force finalize: retry limit exceeded for height ' + height + '. All candidates failed. Manual intervention required.')
                else 
                    logr.fatal('Force finalize: no remaining candidates for height ' + height + ' after eviction. Chain stalled.')
                
                consensus.finalizing = false
                return
            }

            // cleanup P2P blockSenders — delete entries for all finalized blocks
            if (p2p && p2p.blockSenders && winner.block && winner.block.phash)
                Object.keys(p2p.blockSenders).forEach(h => {
                    if (h === winner.block.hash || h === winner.block.phash)
                        delete p2p.blockSenders[h]
                })
            let newPossBlocks = []
            for (let y = 0; y < consensus.possBlocks.length; y++)
                if (height < consensus.possBlocks[y].block._id)
                    newPossBlocks.push(consensus.possBlocks[y])
            consensus.possBlocks = newPossBlocks
            consensus.finalizing = false
            consensus.cancelForceFinalize()
        })
    },
    verifySignature: (message, cb) => {
        if (!message || !message.s) {
            cb(false)
            return
        }
        let sign = message.s.s
        let name = message.s.n
        let sigVersion = message.s.v || 1
        let tmpMess = cloneDeep(message)
        delete tmpMess.s
        let serialized
        if (sigVersion === 2)
            serialized = JSON.stringify(Object.keys(tmpMess).sort().reduce((o, k) => { o[k] = tmpMess[k]; return o }, {}))
        else
            serialized = JSON.stringify(tmpMess)
        let hash = crypto.createHash('sha256').update(serialized).digest('hex')
        let pub = consensus.getActiveLeaderKey(name)
        if (pub && secp256k1.ecdsaVerify(
            bs58.decode(sign),
            Buffer.from(hash, 'hex'),
            bs58.decode(pub))) {
            cb(true)
            return
        }
        // Transition fallback: before the hardfork, accept the other serialization too
        if (!config.forceFinalize) {
            if (sigVersion === 2)
                serialized = JSON.stringify(tmpMess)
            else
                serialized = JSON.stringify(Object.keys(tmpMess).sort().reduce((o, k) => { o[k] = tmpMess[k]; return o }, {}))
            hash = crypto.createHash('sha256').update(serialized).digest('hex')
            if (pub && secp256k1.ecdsaVerify(
                bs58.decode(sign),
                Buffer.from(hash, 'hex'),
                bs58.decode(pub))) {
                cb(true)
                return
            }
        }
        cb(false)
    },
}

module.exports = consensus