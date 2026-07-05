const secp256k1 = require('secp256k1')
const crypto = require('crypto')
const bs58 = require('base-x')(config.b58Alphabet)
const cloneDeep = require('clone-deep')
const consensus_need = 2
const consensus_total = 3
const consensus_threshold = consensus_need/consensus_total

// all p2p.sockets referenced here are verified nodes with a node_status

let consensus = {
    observer: false,
    validating: [],
    processed: [],
    queue: [],
    finalizing: false,
    forceFinalizeTimeout: null,
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
    tryNextStep: () => {
        if (consensus.finalizing) {
            setImmediate(() => consensus.tryNextStep())
            return
        }
        let consensus_size = consensus.activeLeaders().length
        let threshold = consensus_size * consensus_threshold

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
            for (let i in consensus.possBlocks) {
                if (possBlocksById[consensus.possBlocks[i].block._id])
                    possBlocksById[consensus.possBlocks[i].block._id].push(consensus.possBlocks[i])
                else
                    possBlocksById[consensus.possBlocks[i].block._id] = [consensus.possBlocks[i]]
            }
            consensus.possBlocks.sort((a,b) => {
                // valid blocks with different _id must have a different timestamp
                if (a.block.timestamp !== b.block.timestamp)
                    return a.block.timestamp - b.block.timestamp
                else
                    return a.block.hash < b.block.hash ? -1 : 1
            })
        }

        for (let i = 0; i < consensus.possBlocks.length; i++) {
            const possBlock = consensus.possBlocks[i]
            logr.cons('T'+Math.ceil(threshold)+' R0-'+possBlock[0].length+' R1-'+possBlock[1].length)
            // if 2/3+ of the final round and not already finalizing another block
            if (possBlock[config.consensusRounds-1].length > threshold 
            && !consensus.finalizing 
            && possBlock.block._id === chain.getLatestBlock()._id+1
            && possBlock[0] && possBlock[0].indexOf(process.env.NODE_OWNER) !== -1) {
                // block becomes valid, we can move forward !
                consensus.finalizing = true

                // log which block got applied if collision exists
                if (possBlocksById[possBlock.block._id] && possBlocksById[possBlock.block._id].length > 1) {
                    let collisions = []
                    for (let j in possBlocksById[possBlock.block._id])
                        collisions.push([possBlocksById[possBlock.block._id][j].block.miner,possBlocksById[possBlock.block._id][j].block.timestamp])
                    logr.info('Block collision detected at height '+possBlock.block._id+', the leaders are:',collisions)
                    logr.cons('Poss blocks',possBlocksById[possBlock.block._id])
                    logr.info('Applying block '+possBlock.block._id+'#'+possBlock.block.hash.substr(0,4)+' by '+possBlock.block.miner+' with timestamp '+possBlock.block.timestamp)
                } else
                    logr.cons('block '+possBlock.block._id+'#'+possBlock.block.hash.substr(0,4)+' got finalized')

                    if (config.forceFinalize)
                        consensus.cancelForceFinalize()
                    chain.validateAndAddBlock(possBlock.block, false, function(err) {
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
                })
            }
            // if 2/3+ of any previous round, we try to commit it again
            else for (let y = 0; y < config.consensusRounds-1; y++)
                if (possBlock[y].length > threshold)
                    consensus.round(y+1, possBlock.block) 
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
                    logr.error('Received invalid new block from '+block.miner, block.hash)
                    if (cb) cb(-1)
                } else {
                    logr.cons('Precommitting block '+block._id+'#'+block.hash.substr(0,4))

                    // adding to possible blocks
                    consensus.possBlocks.push(possBlock)
                    if (config.forceFinalize)
                        consensus.scheduleForceFinalize()
                    // adding ourselves to precommit list
                    for (let i = 0; i < consensus.possBlocks.length; i++) 
                        if (block.hash === consensus.possBlocks[i].block.hash
                        && consensus.possBlocks[i][0].indexOf(process.env.NODE_OWNER) === -1)
                            possBlock[0].push(process.env.NODE_OWNER)

                    // processing queued messages for this block
                    for (let i = 0; i < consensus.queue.length; i++) {
                        if (consensus.queue[i].d.b.hash === possBlock.block.hash) {
                            // logr.warn('From Queue: '+consensus.queue[i].d.b.hash)
                            consensus.remoteRoundConfirm(consensus.queue[i])
                            consensus.queue.splice(i, 1)
                            i--
                            continue
                        }
                        if (consensus.queue[i].d.ts + 2*config.blockTime < new Date().getTime()) {
                            consensus.queue.splice(i, 1)
                            i--
                        }
                    }

                    // and broadcasting the precommit to our peers
                    consensus.endRound(round, block)

                    if (cb) cb(1)
                }
            })
        } else
            // commit stage
            for (let b = 0; b < consensus.possBlocks.length; b++) 
                if (consensus.possBlocks[b].block.hash === block.hash
                && consensus.possBlocks[b][round].indexOf(process.env.NODE_OWNER) === -1) {
                    consensus.possBlocks[b][round].push(process.env.NODE_OWNER)
                    consensus.endRound(round, block)
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
        consensus.tryNextStep()
    },
    remoteRoundConfirm: (message) => {
        let block = message.d.b
        let round = message.d.r
        let leader = message.s.n
        
        for (let i = 0; i < consensus.possBlocks.length; i++) 
            if (block.hash === consensus.possBlocks[i].block.hash) {
                if (consensus.possBlocks[i][round] && consensus.possBlocks[i][round].indexOf(leader) === -1) {
                    // this leader has not already confirmed this round
                    //  add the leader to the ones who passed precommit
                    
                    for (let r = round; r >= 0; r--)
                        if (consensus.possBlocks[i][r].indexOf(leader) === -1)
                            consensus.possBlocks[i][r].push(leader)
                    
                    consensus.tryNextStep()
                }
                break
            }       
    },
    signMessage: (message) => {
        let hash = crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex')
        let signature = secp256k1.ecdsaSign(Buffer.from(hash, 'hex'), bs58.decode(process.env.NODE_OWNER_PRIV))
        signature = bs58.encode(signature.signature)
        message.s = {
            n: process.env.NODE_OWNER,
            s: signature
        }
        return message
    },
    cancelForceFinalize: () => {
        clearTimeout(consensus.forceFinalizeTimeout)
        consensus.forceFinalizeTimeout = null
    },
    scheduleForceFinalize: () => {
        consensus.cancelForceFinalize()
        const latestBlock = chain.getLatestBlock()
        const expectedHeight = latestBlock._id + 1
        const hasCandidate = consensus.possBlocks.some(pb => pb.block._id === expectedHeight)
        if (!hasCandidate) return

        const fromNow = Math.max(1000,
            latestBlock.timestamp + config.blockTime * (config.leaders + config.consensusRounds + 2) - Date.now()
        )

        logr.debug('Force finalize scheduled in ' + fromNow + 'ms for height ' + expectedHeight)

        consensus.forceFinalizeTimeout = setTimeout(() => {
            consensus._forceFinalize(expectedHeight)
        }, fromNow)

        if (consensus.forceFinalizeTimeout.unref)
            consensus.forceFinalizeTimeout.unref()
    },
    _forceFinalize: (height, retryCount) => {
        if (consensus.finalizing) return
        if (!config.forceFinalize) return
        if (height !== chain.getLatestBlock()._id + 1) return

        if (retryCount === undefined) retryCount = 0

        let candidates = consensus.possBlocks.filter(pb => pb.block._id === height)
        if (candidates.length === 0) {
            logr.warn('Force finalize has no candidates for height ' + height)
            return
        }

        candidates.sort((a, b) => {
            if (a.block.timestamp !== b.block.timestamp)
                return a.block.timestamp - b.block.timestamp
            return a.block.hash < b.block.hash ? -1 : 1
        })

        const winner = candidates[0]

        if (candidates.length > 1) {
            let details = candidates.map(c => [
                c.block.miner,
                c.block._id + '#' + c.block.hash.substr(0, 8),
                c.block.timestamp,
                c.block.hash.substr(0, 8)
            ])
            logr.info('Block collision timeout at height ' + height + ', forced selection:', details)
        }

        logr.warn('Force finalizing block ' + height + '#' + winner.block.hash.substr(0, 8) + ' by ' + winner.block.miner + ' — selected locally without consensus, fork risk if peers diverge')

        consensus.finalizing = true

        chain.validateAndAddBlock(winner.block, false, function(err) {
            if (err) {
                logr.error('Force finalize failed for ' + height + '#' + winner.block.hash.substr(0, 8), err)
                consensus.possBlocks = consensus.possBlocks.filter(pb => pb.block.hash !== winner.block.hash)
                const remaining = consensus.possBlocks.filter(pb => pb.block._id === height)
                if (remaining.length > 0 && retryCount < 3) {
                    logr.warn('Trying next candidate for height ' + height + ' (retry ' + (retryCount + 1) + '/3)')
                    consensus.finalizing = false
                    setImmediate(() => consensus._forceFinalize(height, retryCount + 1))
                    return
                }
                if (remaining.length > 0) {
                    logr.fatal('Force finalize: retry limit exceeded for height ' + height + '. All candidates failed. Manual intervention required.')
                }
                consensus.finalizing = false
                return
            }

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
        let tmpMess = cloneDeep(message)
        delete tmpMess.s
        let hash = crypto.createHash('sha256').update(JSON.stringify(tmpMess)).digest('hex')
        let pub = consensus.getActiveLeaderKey(name)
        if (pub && secp256k1.ecdsaVerify(
            bs58.decode(sign),
            Buffer.from(hash, 'hex'),
            bs58.decode(pub))) {
            cb(true)
            return
        }
        cb(false)
    },
}

module.exports = consensus