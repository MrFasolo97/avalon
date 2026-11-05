const crypto = require('crypto')
const { randomBytes } = crypto
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')(config.b58Alphabet)
const series = require('run-series')
const cloneDeep = require('clone-deep')
const fs = require('fs')
const path = require('path')
const dao = require('./dao')
const daoMaster = require('./daoMaster')
const transaction = require('./transaction.js')
const notifications = require('./notifications.js')
const txHistory = require('./txHistory')
const blocks = require('./blocks')
const leaderHealth = require('./leaderHealth')
const GrowInt = require('growint')
const default_replay_output = 100
const replay_output = process.env.REPLAY_OUTPUT || default_replay_output
// Temporal check bypass for specific block heights during migrations/forks.
// Set via env: SKIP_EARLY_CHECK_BLOCKS=3889058,4000000
const skip_check_early_blocks = (process.env.SKIP_EARLY_CHECK_BLOCKS || '3889058').split(',').map(Number)
const max_batch_blocks = 10000

class Block {
    constructor(index, phash, timestamp, txs, miner, missedBy, dist, burn, signature, hash, skips) {
        this._id = index
        this.phash = phash.toString()
        this.timestamp = timestamp
        this.txs = txs
        this.miner = miner
        if (missedBy) this.missedBy = missedBy
        if (skips && skips.length) this.skips = skips
        if (dist) this.dist = dist
        if (burn) this.burn = burn
        this.hash = hash
        this.signature = signature
    }
}

let chain = {
    blocksToRebuild: [],
    restoredBlocks: 0,
    schedule: null,
    recentBlocks: [],
    recentTxs: {},
    getNewKeyPair: () => {
        let privKey, pubKey
        do {
            privKey = randomBytes(config.randomBytesLength)
            pubKey = secp256k1.publicKeyCreate(privKey)
        } while (!secp256k1.privateKeyVerify(privKey))
    
        return {
            pub: bs58.encode(pubKey),        
            priv: bs58.encode(privKey)
        }
    },
    getGenesisBlock: () => {
        return new Block(
            0,
            '0',
            0,
            [],
            config.masterName,
            null,
            null,
            null,
            '0000000000000000000000000000000000000000000000000000000000000000',
            config.originHash
        )
    },
    prepareBlock: () => {
        let previousBlock = chain.getLatestBlock()
        let nextIndex = previousBlock._id + 1
        let nextTimestamp = new Date().getTime()
        // grab all transactions and sort by ts
        let txs = []
        let mempool = transaction.pool.sort(function(a,b){return a.ts-b.ts})
        const maxPerSender = Math.max(1, Math.floor(config.maxTxPerBlock / 10))
        // pass 1: at most 1 tx per unique sender (fairness)
        loopOne:
        for (let i = 0; i < mempool.length; i++) {
            if (txs.length === config.maxTxPerBlock)
                break
            for (let y = 0; y < txs.length; y++)
                if (txs[y].sender === mempool[i].sender)
                    continue loopOne
            txs.push(mempool[i])
        }

        // pass 2: fill remaining slots with a per-sender cap
        const senderCounts = {}
        loopTwo:
        for (let i = 0; i < mempool.length; i++) {
            if (txs.length === config.maxTxPerBlock)
                break
            for (let y = 0; y < txs.length; y++)
                if (txs[y].hash === mempool[i].hash)
                    continue loopTwo
            const sender = mempool[i].sender || 'unknown'
            senderCounts[sender] = (senderCounts[sender] || 0) + 1
            if (senderCounts[sender] > maxPerSender)
                continue loopTwo
            txs.push(mempool[i])
        }
        txs = txs.sort(function(a,b){return a.ts-b.ts})
        transaction.removeFromPool(txs)
        // Layer S/H: attach our skip attestation here, before canMineBlock()
        // pre-validates the block. The ladder only depends on (height, schedule,
        // recentBlocks) which are unchanged between prepareBlock() and mineBlock(),
        // so the strict "backup miner must attest skips" rule was rejecting every
        // single block a node tried to mine as a backup (permanent stall whenever
        // the scheduled leader was late/down).
        const ladder = chain.leaderLadder(nextIndex)
        const myPos = ladder.indexOf(process.env.NODE_OWNER)
        const skips = myPos > 0 ? ladder.slice(0, myPos) : null
        // NOTE: do NOT create the block first and append missedBy/skips afterwards.
        // blockHashSerialization 2 hashes JSON.stringify(block), so the insertion
        // order of the optional fields is part of the signed payload. Passing them
        // through the constructor (fixed order: missedBy, skips, dist, burn) keeps
        // the producer's serialization identical to the one every validator
        // rebuilds from the wire/DB.
        return new Block(nextIndex, previousBlock.hash, nextTimestamp, txs,
            process.env.NODE_OWNER, skips ? skips[0] : null, null, null, null, null, skips)
    },
    hashAndSignBlock: (block) => {
        // Hash the canonical form (hash/signature removed): that is exactly what
        // isValidHashAndSignature() recomputes on every validator, so signing any
        // other serialization makes the block unverifiable by everyone else.
        let nextHash = chain.calculateHashForBlock(block, true)
        let signature = secp256k1.ecdsaSign(Buffer.from(nextHash, 'hex'), bs58.decode(process.env.NODE_OWNER_PRIV))
        signature = bs58.encode(signature.signature)
        return new Block(block._id, block.phash, block.timestamp, block.txs, block.miner, block.missedBy, block.dist, block.burn, signature, nextHash, block.skips)
    },
    canMineBlock: (cb) => {
        if (chain.shuttingDown) {
            cb(true, null); return
        }
        let newBlock = chain.prepareBlock()
        // run the transactions and validation
        // pre-validate our own block (not the hash and signature as we dont have them yet)
        // nor transactions because we will filter them on execution later
        chain.isValidNewBlock(newBlock, false, false, function(isValid) {
            if (!isValid) {
                cb(true, newBlock); return
            }
            cb(null, newBlock)
        })
    },
    mineBlock: (cb) => {
        if (chain.shuttingDown) return
        chain.canMineBlock(function(err, newBlock) {
            if (err) {
                cb(true, newBlock); return
            }

            // at this point transactions in the pool seem all validated
            // BUT with a different ts and without checking for double spend
            // so we will execute transactions in order and revalidate after each execution
            chain.executeBlockTransactions(newBlock, true, function(validTxs, distributed, burned) {
                cache.rollback()
                dao.resetID()
                daoMaster.resetID()
                // always record the failure of others
                const finalHeight = newBlock._id
                const ladder = chain.leaderLadder(finalHeight)
                const myPos = ladder.indexOf(process.env.NODE_OWNER)
                let skips = null
                let missedBy = null
                if (myPos > 0) {
                    skips = ladder.slice(0, myPos)
                    missedBy = skips[0]
                } else {
                    const scheduled = chain.schedule.shuffle[(finalHeight-1)%config.leaders]
                    // fallback for the legacy field only
                    if (scheduled && scheduled.name !== process.env.NODE_OWNER)
                        missedBy = scheduled.name
                }

                // Rebuild the block instead of mutating it: the field order is part
                // of the v2 hash (JSON.stringify), so dist/burn/missedBy/skips must
                // be inserted in constructor order on the producer as well.
                newBlock = new Block(finalHeight, newBlock.phash, newBlock.timestamp, validTxs,
                    newBlock.miner, missedBy, distributed, burned, null, null, skips)

                // hash and sign the block with our private key
                newBlock = chain.hashAndSignBlock(newBlock)
                
                // push the new block to consensus possible blocks
                // and go straight to end of round 0 to skip re-validating the block
                let possBlock = {
                    block: newBlock
                }
                for (let r = 0; r < config.consensusRounds; r++)
                    possBlock[r] = []

                logr.debug('Mined a new block, proposing to consensus')

                // own vote is recorded and broadcast by endRound()
                consensus.possBlocks.push(possBlock)
                if (config.forceFinalize)
                    consensus.scheduleForceFinalize()
                consensus.endRound(0, newBlock)
                cb(null, newBlock)
            })
        })
    },
    validateAndAddBlock: (newBlock, revalidate, cb) => {
        // when we receive an outside block and check whether we should add it to our chain or not
        if (chain.shuttingDown) return
        chain.isValidNewBlock(newBlock, revalidate, false, function(isValid) {
            if (!isValid) 
                return cb(true, newBlock)
            
            // straight execution
            chain.executeBlockTransactions(newBlock, revalidate, function(validTxs, distributed, burned) {
                // if any transaction is wrong, thats a fatal error
                if (newBlock.txs.length !== validTxs.length) {
                    logr.error('Invalid tx(s) in block')
                    cb(true, newBlock); return
                }

                // error if distributed or burned computed amounts are different than the reported one
                let blockDist = newBlock.dist || 0
                if (blockDist !== distributed) {
                    logr.error('Wrong dist amount', blockDist, distributed)
                    cb(true, newBlock); return
                }
                let blockBurn = newBlock.burn || 0
                if (blockBurn !== burned) {
                    logr.error('Wrong burn amount', blockBurn, burned)
                    cb(true, newBlock); return
                }

                // add txs to recents
                chain.addRecentTxsInBlock(newBlock.txs)

                // remove all transactions from this block from our transaction pool
                transaction.removeFromPool(newBlock.txs)

                chain.addBlock(newBlock, function() {
                    // and broadcast to peers (if not replaying)
                    if (!p2p.recovering)
                        p2p.broadcastBlock(newBlock)

                    // process notifications and leader stats (non blocking)
                    notifications.processBlock(newBlock)

                    // emit event to confirm new transactions in the http api
                    if (!p2p.recovering)
                        for (let i = 0; i < newBlock.txs.length; i++)
                            transaction.eventConfirmation.emit(newBlock.txs[i].hash)

                    cb(null, newBlock)
                })
            })
        })
    },
    addRecentTxsInBlock: (txs = []) => {
        for (let t = 0; t < txs.length; t++)
            chain.recentTxs[txs[t].hash] = txs[t]
    },
    pendingBlocks: [],
    pendingBlockTimer: null,
    addPendingBlock: (block) => {
        if (!block || !block.hash) return
        for (let i = 0; i < chain.pendingBlocks.length; i++)
            if (chain.pendingBlocks[i].block.hash === block.hash)
                return
        if (chain.pendingBlocks.length >= 100) {
            logr.warn('Pending block queue at capacity, dropping oldest')
            chain.pendingBlocks.shift()
        }
        chain.pendingBlocks.push({ block: block, added: new Date().getTime() })
        chain.schedulePendingBlocks()
    },
    schedulePendingBlocks: () => {
        if (chain.pendingBlockTimer) return
        if (chain.pendingBlocks.length === 0) return
        const next = chain.pendingBlocks[0].block.timestamp - new Date().getTime()
        const delay = Math.max(50, Math.min(next, 5000))
        chain.pendingBlockTimer = setTimeout(() => {
            chain.pendingBlockTimer = null
            chain.processPendingBlocks()
        }, delay)
    },
    processPendingBlocks: () => {
        if (chain.pendingBlocks.length === 0) return
        const now = new Date().getTime()
        const kept = []
        for (const item of chain.pendingBlocks) {
            // Drop stale entries: if it was ever going to validate it would have
            // done so quickly after its timestamp (pendingBlockMaxMs, plan §5.4).
            if (item.added + (config.pendingBlockMaxMs || 30000) < now) {
                logr.debug('Dropping stale pending block ' + item.block._id + '#' + item.block.hash.substr(0, 8))
                continue
            }
            // If still too far in the future, keep it.
            if (item.block.timestamp > now + config.maxDrift) {
                kept.push(item)
                continue
            }
            // Try to validate it now. If it is the next block, add it.
            chain.isValidNewBlock(item.block, true, true, function(isValid) {
                if (isValid && item.block._id === chain.getLatestBlock()._id + 1 && p2p && p2p.addRecursive)
                    p2p.addRecursive(item.block)
                else if (!isValid)
                    logr.debug('Pending block ' + item.block._id + '#' + item.block.hash.substr(0, 8) + ' still invalid')
            })
        }
        chain.pendingBlocks = kept
        chain.schedulePendingBlocks()
    },
    minerWorker: (block) => {
        if (p2p.recovering) return
        clearTimeout(chain.worker)

        if (chain.schedule.shuffle.length === 0) {
            logr.fatal('All leaders gave up their stake? Chain is over')
            process.exit(1)
        }

        const height = block._id + 1
        const ladder = chain.leaderLadder(height)
        const pos = ladder.indexOf(process.env.NODE_OWNER)
        if (pos === -1) return

        let mineInMs = (pos + 1) * config.blockTime
        if (pos > 0) mineInMs += config.skipGraceMs || 0

        mineInMs -= (new Date().getTime()-block.timestamp)
        mineInMs += 20
        logr.debug('Trying to mine in '+mineInMs+'ms (ladder pos '+pos+')')
        consensus.observer = false
        if (mineInMs < config.blockTime/2) {
            // Giving up the slot is only safe if somebody else can take it.
            // With no other miner in the recent history (genesis, a 1-node
            // testnet, or a network where the others are down) this return
            // stops the chain permanently: the next scheduled slot belongs
            // to the same node, and it will be late again.
            const recent = chain.recentBlocks.slice(-2*config.leaders)
            const othersProducing = recent.some(b => b.miner && b.miner !== process.env.NODE_OWNER)
            // If the head itself is stale the chain is HALTED: nobody else is
            // going to produce instead of us, so giving up the slot here (the D3
            // fix for a healthy chain) would freeze it forever. Mine anyway.
            const chainHalted = (new Date().getTime() - block.timestamp) > config.blockTime * config.leaders
            if (chainHalted) {
                // Head is old: the ladder timing is meaningless (every slot is
                // already "due"). Instead of making the backups give up — which
                // froze the chain forever whenever the scheduled leader was down
                // — stagger them by position (pos*blockTime from now) and let the
                // one-proposer check in the timer callback make later backups
                // yield once an earlier one produced. That keeps ONE candidate per
                // round (no scatter) while letting a backup take over when the
                // scheduled leader is absent.
                mineInMs = 20 + pos * config.blockTime
                logr.warn('Chain halted (head is old): '
                    + (pos === 0 ? 'scheduled leader' : 'backup pos ' + pos) + ' will try to mine')
            } else if (othersProducing) {
                logr.warn('Slow performance detected, will not try to mine next block')
                return
            } else {
                logr.warn('Slow performance detected and no other leader is producing: mining anyway')
                // keep the computed delay: it lands the block exactly on
                // prev.timestamp + blockTime. Clamping to "now" would produce a
                // block that is too early and be rejected by validation.
                mineInMs = Math.max(mineInMs, 20)
            }
        }
        chain.worker = setTimeout(function(){
            // One proposer per round: a BACKUP proposes only if no candidate block
            // for this height has been seen yet — i.e. the leader's (and earlier
            // backups') slots are proven empty. The scheduled leader (ladder
            // position 0) always proposes. This stops a backup from adding a
            // second candidate for a height the leader already filled, which is
            // what makes strict single-vote freeze.
            const candidateSeen = pos > 0 && consensus.possBlocks.some(function(pb) {
                return pb && pb.block && pb.block._id === height
            })
            if (candidateSeen) {
                logr.debug('one-proposer: candidate for ' + height + ' already seen; backup pos ' + pos + ' yields')
                return
            }
            chain.mineBlock(function(error, finalBlock) {
                if (error)
                    logr.warn('miner worker trying to mine but couldnt', finalBlock)
            })
        }, mineInMs)
    },
    addBlock: async (block, cb) => {
        // add the block in our own db
        if (blocks.isOpen)
            blocks.appendBlock(block)
        else
            await db.collection('blocks').insertOne(block)

        // push cached accounts and contents to mongodb
        chain.cleanMemory()

        // update the config if an update was scheduled (remove stale keys)
        const freshConfig = require('./config.js').read(block._id)
        for (const k of Object.keys(config))
            if (!(k in freshConfig))
                delete config[k]
        Object.assign(config, freshConfig)
        chain.applyHardforkPostBlock(block._id)
        eco.appendHistory(block)
        eco.nextBlock()
        dao.nextBlock()
        daoMaster.nextBlock()
        leaderHealth.processBlock(block, chain.schedule)
        leaderStats.processBlock(block)
        txHistory.processBlock(block)

        // if block id is mult of n leaders, reschedule next n blocks
        if (block._id % config.leaders === 0) {
            chain.schedule = chain.minerSchedule(block)
            chain.saveSchedule()
        }
        chain.recentBlocks.push(block)
        chain.minerWorker(block)
        chain.output(block)
        cache.writeToDisk(false)
        cb(true)
    },
    output: (block,rebuilding) => {
        chain.nextOutput.txs += block.txs.length
        if (block.dist)
            chain.nextOutput.dist += block.dist
        if (block.burn)
            chain.nextOutput.burn += block.burn

        if (block._id%replay_output === 0 || (!rebuilding && !p2p.recovering)) {
            let currentOutTime = new Date().getTime()
            let output = ''
            if (rebuilding)
                output += 'Rebuilt '

            output += '#'+block._id

            if (rebuilding)
                output += '/' + chain.restoredBlocks
            else
                // eslint-disable-next-line no-control-regex
                output += '  by '+(block.miner||'').replace(/[\x00-\x1f]/g, '')

            output += '  '+chain.nextOutput.txs+' tx'
            if (chain.nextOutput.txs>1)
                output += 's'

            output += '  dist: '+eco.round(chain.nextOutput.dist)
            output += '  burn: '+eco.round(chain.nextOutput.burn)
            output += '  delay: '+ (currentOutTime - block.timestamp)

            if (block.missedBy && !rebuilding)
                output += '  MISS: '+block.missedBy
            else if (rebuilding) {
                output += '  Performance: ' + Math.floor(replay_output/(currentOutTime-chain.lastRebuildOutput)*1000) + 'b/s'
                chain.lastRebuildOutput = currentOutTime
            }

            logr.info(output)
            chain.nextOutput = {
                txs: 0,
                dist: 0,
                burn: 0
            }
        }
            
    },
    nextOutput: {
        txs: 0,
        dist: 0,
        burn: 0
    },
    lastRebuildOutput: 0,
    isValidPubKey: (key) => {
        try {
            return secp256k1.publicKeyVerify(bs58.decode(key))
        } catch (error) {
            return false
        }
    },
    isValidSignature: (user, txType, hash, sign, cb) => {
        // verify signature and bandwidth
        cache.findOne('accounts', {name: user}, async function(err, account) {
            try {
                if (err) throw err
                if (!account) {
                    cb(false); return
                } else if (chain.restoredBlocks && chain.getLatestBlock()._id < chain.restoredBlocks && process.env.REBUILD_NO_VERIFY === '1')
                // no verify rebuild mode, only use if you trust the contents of blocks.zip
                    return cb(account)

                // main key can authorize all transactions
                let allowedPubKeys = [[account.pub, account.pub_weight || 1]]
                let threshold = 1
                // add all secondary keys having this transaction type as allowed keys
                if (account.keys && typeof txType === 'number' && Number.isInteger(txType))
                    for (let i = 0; i < account.keys.length; i++) 
                        if (account.keys[i].types.indexOf(txType) > -1)
                            allowedPubKeys.push([account.keys[i].pub, account.keys[i].weight || 1])
                // account authorities
                if (account.auths && Array.isArray(account.auths) && typeof txType === 'number' && Number.isInteger(txType))
                    for (let i = 0; i < account.auths.length; i++)
                        if (account.auths[i].types.indexOf(txType) > -1) {
                            let authorizedAcc = await cache.findOnePromise('accounts',{name: account.auths[i].user})
                            if (authorizedAcc && authorizedAcc.keys && Array.isArray(authorizedAcc.keys))
                                for (let a = 0; a < authorizedAcc.keys.length; a++)
                                    if (authorizedAcc.keys[a].id === account.auths[i].id) {
                                        allowedPubKeys.push([authorizedAcc.keys[a].pub, account.auths[i].weight || 1])
                                        break
                                    }
                        }

                // if there is no transaction type
                // it means we are verifying a block signature
                // so only the leader key is allowed
                if (txType === null)
                    if (account.pub_leader)
                        allowedPubKeys = [[account.pub_leader, 1]]
                    else
                        allowedPubKeys = []
                // compute required signature threshold otherwise
                else if (account.thresholds && account.thresholds[txType])
                    threshold = account.thresholds[txType]
                else if (account.thresholds && account.thresholds.default)
                    threshold = account.thresholds.default

                // multisig transactions
                if (config.multisig && Array.isArray(sign))
                    return chain.isValidMultisig(account,threshold,allowedPubKeys,hash,sign,cb)
            
                // single signature
                try {
                    for (let i = 0; i < allowedPubKeys.length; i++) {
                        let bufferHash = Buffer.from(hash, 'hex')
                        let b58sign = bs58.decode(sign)
                        let b58pub = bs58.decode(allowedPubKeys[i][0])
                        if (secp256k1.ecdsaVerify(b58sign, bufferHash, b58pub) && allowedPubKeys[i][1] >= threshold) {
                            cb(account)
                            return
                        }
                    }
                } catch (e) {}
                cb(false)
            } catch (e) {
                logr.error('Unhandled error in isValidSignature', e)
                cb(false)
            }
        })
    },
    isValidMultisig: (account,threshold,allowedPubKeys,hash,signatures,cb) => {
        if (!Array.isArray(signatures) || signatures.length > 50) 
            return cb(false, 'invalid signature count')
        
        let validWeights = 0
        let validSigSet = new Set()
        try {
            let allowedPubSet = {}
            for (let p = 0; p < allowedPubKeys.length; p++)
                allowedPubSet[allowedPubKeys[p][0]] = true
            let hashBuf = Buffer.from(hash, 'hex')
            for (let s = 0; s < signatures.length; s++) {
                let signBuf = bs58.decode(signatures[s][0])
                let recoveredPub = bs58.encode(secp256k1.ecdsaRecover(signBuf,signatures[s][1],hashBuf))
                if (!allowedPubSet[recoveredPub] || validSigSet.has(recoveredPub))
                    continue
                for (let p = 0; p < allowedPubKeys.length; p++)
                    if (allowedPubKeys[p][0] === recoveredPub) {
                        validWeights += allowedPubKeys[p][1]
                        validSigSet.add(recoveredPub)
                    }
            }
        } catch (e) {
            return cb(false, 'invalid signatures: ' + e.toString())
        }
        if (validWeights >= threshold)
            cb(account)
        else
            cb(false, 'insufficient signature weight ' + validWeights + ' to reach threshold of ' + threshold)
    },
    isValidHashAndSignature: (newBlock, cb) => {
        // and that the hash is correct
        let theoreticalHash = chain.calculateHashForBlock(newBlock,true)
        if (theoreticalHash !== newBlock.hash) {
            logr.debug(typeof (newBlock.hash) + ' ' + typeof theoreticalHash)
            logr.error('invalid hash: ' + theoreticalHash + ' ' + newBlock.hash)
            cb(false); return
        }

        // finally, verify the signature of the miner
        chain.isValidSignature(newBlock.miner, null, newBlock.hash, newBlock.signature, function(legitUser) {
            if (!legitUser) {
                logr.error('invalid miner signature')
                cb(false); return
            }
            cb(true)
        })
    },
    isValidBlockTxs: (newBlock, cb) => {
        chain.executeBlockTransactions(newBlock, true, function(validTxs, dist, burn) {
            cache.rollback()
            dao.resetID()
            daoMaster.resetID()
            if (validTxs.length !== newBlock.txs.length) {
                logr.error('invalid block transaction')
                cb(false); return
            }
            let blockDist = newBlock.dist || 0
            if (blockDist !== dist) {
                logr.error('Wrong dist amount',blockDist,dist)
                return cb(false)
            }

            let blockBurn = newBlock.burn || 0
            if (blockBurn !== burn) {
                logr.error('Wrong burn amount',blockBurn,burn)
                return cb(false)
            }
            cb(true)
        })
    },
    isValidNewBlock: (newBlock, verifyHashAndSignature, verifyTxValidity, cb) => {
        if (!newBlock) return
        // verify all block fields one by one
        if (!newBlock._id || typeof newBlock._id !== 'number') {
            logr.error('invalid block _id')
            cb(false); return
        }
        if (!newBlock.phash || typeof newBlock.phash !== 'string') {
            logr.error('invalid block phash')
            cb(false); return
        }
        if (!newBlock.timestamp || typeof newBlock.timestamp !== 'number') {
            logr.error('invalid block timestamp')
            cb(false); return
        }
        if (!newBlock.txs || typeof newBlock.txs !== 'object' || !Array.isArray(newBlock.txs)) {
            logr.error('invalid block txs')
            cb(false); return
        }
        if (newBlock.txs.length > config.maxTxPerBlock) {
            logr.error('invalid block too many txs')
            cb(false); return
        }
        if (!newBlock.miner || typeof newBlock.miner !== 'string') {
            logr.error('invalid block miner')
            cb(false); return
        }
        if (verifyHashAndSignature && (!newBlock.hash || typeof newBlock.hash !== 'string')) {
            logr.error('invalid block hash')
            cb(false); return
        }
        if (verifyHashAndSignature && (!newBlock.signature || typeof newBlock.signature !== 'string')) {
            logr.error('invalid block signature')
            cb(false); return
        }
        // Layer S/H: validate the optional skip attestation. Bounds are checked on
        // every node; the canonical-prefix check is warn-mode in Layer S and a hard
        // reject in Layer H (§4.1 / §5.3). A scheduled leader may omit `skips`
        // entirely (an empty array is not serialised by the Block constructor); a
        // backup that omits it is only a hard error in Layer H.
        const ladder = chain.leaderLadder(newBlock._id)
        const myPos = ladder.indexOf(newBlock.miner)
        const expectedSkips = myPos > 0 ? ladder.slice(0, myPos) : []
        const skipsCheck = chain.checkSkipAttestation(newBlock.skips, expectedSkips, newBlock.miner)
        if (!skipsCheck.ok) {
            const fatal = config.skipStrict && skipsCheck.reason !== 'absent'
            const missingBackupAttestation = config.skipStrict && myPos > 0 && skipsCheck.reason === 'absent'
            if (fatal || missingBackupAttestation) {
                logr.error('invalid block skips at '+newBlock._id+' ('+skipsCheck.reason+')')
                cb(false)
                return
            }
            if (skipsCheck.reason !== 'absent')
                logr.warn('invalid block skips at '+newBlock._id+' ('+skipsCheck.reason+'): '
                    +JSON.stringify(newBlock.skips)+' expected '+JSON.stringify(expectedSkips))
        }


        if (newBlock.missedBy && typeof newBlock.missedBy !== 'string')
            logr.error('invalid block missedBy')

        // verify that its indeed the next block
        let previousBlock = chain.getLatestBlock()
        if (previousBlock._id + 1 !== newBlock._id) {
            logr.error('invalid index')
            cb(false); return
        }
        // from the same chain
        if (previousBlock.hash !== newBlock.phash) {
            logr.error('invalid phash')
            cb(false); return
        }

        // check if miner isnt trying to fast forward time
        // this might need to be tuned in the future to allow for network delay / clocks desync / etc
        if (newBlock.timestamp > new Date().getTime() + config.maxDrift) {
            // Layer S/H: queue future-dated blocks instead of hard-rejecting them.
            // A block that is only slightly ahead of our clock will validate once
            // its timestamp is in the allowed drift window. Hard-rejecting was a
            // major source of stalls on Docker testnets with clock skew.
            if (config.skipRecording || config.haltBreaker) {
                logr.warn('timestamp from the future, queuing for later', newBlock._id, newBlock.timestamp, new Date().getTime())
                chain.addPendingBlock(newBlock)
            } else
                logr.error('timestamp from the future', newBlock.timestamp, new Date().getTime())
            cb(false); return
        }

        // check if miner is normal scheduled one or a backup
        // (ladder already computed above for skip validation)
        const minerPriority = ladder.indexOf(newBlock.miner) + 1
        if (minerPriority === 0) {
            logr.error('unauthorized miner')
            cb(false); return
        }

        // check if new block isnt too early
        if (newBlock.timestamp - previousBlock.timestamp < minerPriority*config.blockTime && skip_check_early_blocks.indexOf(newBlock._id) === -1) {
            logr.error('block too early for miner with priority #'+minerPriority)
            cb(false); return
        }

        if (!verifyTxValidity) {
            if (!verifyHashAndSignature) {
                cb(true); return
            }
            chain.isValidHashAndSignature(newBlock, function(isValid) {
                if (!isValid) {
                    cb(false); return
                }
                cb(true)
            })
        } else
            chain.isValidBlockTxs(newBlock, function(isValid) {
                if (!isValid) {
                    cb(false); return
                }
                if (!verifyHashAndSignature) {
                    cb(true); return
                }
                chain.isValidHashAndSignature(newBlock, function(isValid) {
                    if (!isValid) {
                        cb(false); return
                    }
                    cb(true)
                })
            })
    },
    isValidNewBlockPromise: (newBlock, verifyHashAndSig, verifyTxValidity) => new Promise((rs) => chain.isValidNewBlock(newBlock, verifyHashAndSig, verifyTxValidity, rs)),
    executeBlockTransactions: (block, revalidate, cb) => {
        // revalidating transactions in orders if revalidate = true
        // adding transaction to recent transactions (to prevent tx re-use) if isFinal = true
        let executions = []
        for (let i = 0; i < block.txs.length; i++) 
            executions.push(function(callback) {
                let tx = block.txs[i]
                if (revalidate)
                    transaction.isValid(tx, block.timestamp, function(isValid, error) {
                        if (isValid) 
                            transaction.execute(tx, block.timestamp, function(executed, distributed, burned) {
                                if (!executed) {
                                    logr.fatal('Tx execution failure', tx)
                                    process.exit(1)
                                }
                                callback(null, {
                                    executed: executed,
                                    distributed: distributed,
                                    burned: burned
                                })
                            })
                        else {
                            logr.error(error, tx)
                            callback(null, false)
                        }
                    })
                else
                    transaction.execute(tx, block.timestamp, function(executed, distributed, burned) {
                        if (!executed)
                            logr.fatal('Tx execution failure', tx)
                        callback(null, {
                            executed: executed,
                            distributed: distributed,
                            burned: burned
                        })
                    })
            })
        executions.push((callback) => chain.applyHardfork(block,callback))
        
        let blockTimeBefore = new Date().getTime()
        series(executions, async function(err, results) {
            let string = 'executed'
            if(revalidate) string = 'validated & '+string
            logr.debug('Block '+string+' in '+(new Date().getTime()-blockTimeBefore)+'ms')
            if (err) throw err
            let executedSuccesfully = []
            let distributedInBlock = 0
            let burnedInBlock = 0
            for (let i = 0; i < results.length; i++) {
                if (results[i].executed)
                    executedSuccesfully.push(block.txs[i])
                if (results[i].distributed)
                    distributedInBlock += results[i].distributed
                if (results[i].burned)
                    burnedInBlock += results[i].burned
            }

            // execute periodic burn
            let additionalBurn = await chain.decayBurnAccount(block)

            // execute dao triggers
            let daoBurn = await dao.runTriggers(block.timestamp)

            // add rewards for the leader who mined this block
            chain.leaderRewards(block.miner, block.timestamp, function(dist) {
                distributedInBlock += dist
                distributedInBlock = Math.round(distributedInBlock*1000) / 1000
                burnedInBlock += additionalBurn
                burnedInBlock += daoBurn
                burnedInBlock = Math.round(burnedInBlock*1000) / 1000
                cb(executedSuccesfully, distributedInBlock, burnedInBlock)
            })
        })
    },
    // Canonical turn ladder for height h (Layer S/H).
    // Deterministic: every node with the same schedule and recentBlocks computes
    // the same array. Position 0 is the scheduled leader S(h); positions 1..L are
    // recent producers used as backups; position p implies gap >= (p+1)*blockTime.
    leaderLadder: (height) => {
        const L = config.leaders
        const out = []
        if (chain.schedule && chain.schedule.shuffle) {
            const s = chain.schedule.shuffle[(height - 1) % L]
            if (s && s.name && out.indexOf(s.name) === -1) out.push(s.name)
        }
        for (let i = 1; i <= L; i++) {
            const b = chain.recentBlocks[chain.recentBlocks.length - i]
            if (!b || !b.miner) break
            if (out.indexOf(b.miner) === -1) out.push(b.miner)
        }
        return out
    },

    // Pure skip-attestation check (Layer S/H, plan §4.1/§5.3). `expectedSkips`
    // is the canonical ladder prefix before the producer. Returns { ok, reason }:
    //   'absent'   -> skips undefined (fine for the scheduled leader; a miss for a backup)
    //   'not-array'/'too-many'/'bad-name'/'duplicate'/'miner-in-skips' -> structurally invalid
    //   'mismatch' -> well-formed but not the canonical prefix
    // The caller decides warn (Layer S) vs reject (Layer H); this is pure so it
    // is unit-testable without the block-validation machinery.
    checkSkipAttestation: (skips, expectedSkips, miner) => {
        if (skips === undefined) return { ok: false, reason: 'absent' }
        if (!Array.isArray(skips)) return { ok: false, reason: 'not-array' }
        const max = config.leaders + (config.leaderStandbys || 0)
        if (skips.length > max) return { ok: false, reason: 'too-many' }
        for (let i = 0; i < skips.length; i++) {
            const name = skips[i]
            if (typeof name !== 'string'
            || name.length < (config.accountMinLength || 1)
            || name.length > (config.accountMaxLength || 50))
                return { ok: false, reason: 'bad-name' }
        }
        if (new Set(skips).size !== skips.length) return { ok: false, reason: 'duplicate' }
        if (skips.indexOf(miner) !== -1) return { ok: false, reason: 'miner-in-skips' }
        const expected = Array.isArray(expectedSkips) ? expectedSkips : []
        const same = skips.length === expected.length && skips.every((n, i) => n === expected[i])
        if (!same) return { ok: false, reason: 'mismatch' }
        return { ok: true }
    },

    // Deterministic, chain-derived rank for a candidate block. Used by
    // force-finalize and halt-breaker to make sure every node picks the same
    // winner when timestamps collide. Lower rank = preferred.
    deriveBlockRank: (block) => {
        const ladder = chain.leaderLadder(block._id)
        const pos = ladder.indexOf(block.miner)
        return {
            timestamp: block.timestamp,
            ladderPos: pos >= 0 ? pos : 999,
            hash: block.hash || ''
        }
    },

    compareBlockRank: (a, b) => {
        if (a.timestamp !== b.timestamp)
            return a.timestamp - b.timestamp
        if (a.ladderPos !== b.ladderPos)
            return a.ladderPos - b.ladderPos
        return String(a.hash).localeCompare(String(b.hash))
    },

    // Persist the current epoch schedule to disk. This fixes F7 restart
    // divergence: after a restart every node reloads the exact schedule it was
    // using, instead of recomputing it from a block that may not be in memory.
    schedulePersistPath: process.env.SCHEDULE_PERSIST_PATH || './state/schedule.json',
    saveSchedule: () => {
        if (!chain.schedule) return
        const file = chain.schedulePersistPath
        try {
            const dir = path.dirname(file)
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true })
            const data = JSON.stringify({
                height: chain.getLatestBlock()._id,
                schedule: chain.schedule
            })
            fs.writeFileSync(file + '.tmp', data)
            fs.renameSync(file + '.tmp', file)
        } catch (e) {
            logr.error('Failed to persist schedule', e)
        }
    },
    loadSchedule: () => {
        const file = chain.schedulePersistPath
        try {
            if (!fs.existsSync(file)) return null
            const raw = fs.readFileSync(file, 'utf8')
            const parsed = JSON.parse(raw)
            if (!parsed || !parsed.schedule || !parsed.schedule.shuffle
            || !Array.isArray(parsed.schedule.shuffle)) return null
            return parsed
        } catch (e) {
            logr.error('Failed to load persisted schedule', e)
            return null
        }
    },

    // Leader rotation set for the current epoch.
    // Layer S: uses generateLeaders() (approval order, top N).
    // Layer H: canonical order (node_appr desc, name asc), jail filter, and
    // standby promotion. The standby pool is the slice immediately below the
    // active set; jailed actives are replaced by standbys at epoch boundaries.
    //
    // `config.masterLeaderUntil` (testnet/drill knob, default null = never):
    // the master account is a leader from genesis by construction (its own
    // balance seeds node_appr), which is required to bootstrap a fresh chain
    // before any miner node exists. Once enough real leaders have been voted in
    // it leaves the rotation, otherwise it would permanently occupy one of the L
    // slots (and, on the drills, hide the standbys behind it).
    // The "enough real leaders" guard makes it impossible to deadlock: the
    // master only steps out when the rotation can be filled without it.
    masterIsLeaderNow: (height, others) => {
        if (typeof config.masterLeaderUntil !== 'number') return true
        if (height <= config.masterLeaderUntil) return true
        return others < config.leaders
    },
    filterMaster: (list, height) => {
        const others = list.filter(l => l.name !== config.masterName)
        if (chain.masterIsLeaderNow(height, others.length)) return list
        return others
    },
    activeLeaderSet: () => {
        const headHeight = chain.getLatestBlock()._id
        if (!config.canonicalLeaderOrder)
            return chain.filterMaster(chain.generateLeaders(true, false, config.leaders, 0), headHeight)

        const need = config.leaders
        const standbyCount = config.leaderStandbys || 0
        const all = chain.generateLeaders(true, false, need + standbyCount + 20, 0)

        // Canonical ordering: approval descending, then name ascending for
        // deterministic tie-breaking.
        all.sort((a, b) => {
            if (b.node_appr !== a.node_appr)
                return b.node_appr - a.node_appr
            if (a.name < b.name) return -1
            if (a.name > b.name) return 1
            return 0
        })

        // Filter jailed leaders. Layer H jail state is derived from skips[].
        const notJailed = chain.filterMaster(all, headHeight).filter(l => !leaderHealth.isJailed(l.name, headHeight))

        let actives = notJailed.slice(0, need)
        // If jailing shrunk the active set, promote standbys from the ordered
        // pool below the active cut.
        if (actives.length < need)
            actives = notJailed.slice(0, need)

        return actives
    },

    // Standby pool for Layer H: leaders immediately below the active cut that
    // are not jailed. Exposed via /consensus and used at epoch boundaries.
    standbyLeaderSet: () => {
        if (!config.canonicalLeaderOrder) return []
        const headHeight = chain.getLatestBlock()._id
        const need = config.leaders
        const standbyCount = config.leaderStandbys || 0
        const all = chain.generateLeaders(true, false, need + standbyCount + 20, 0)
        all.sort((a, b) => {
            if (b.node_appr !== a.node_appr)
                return b.node_appr - a.node_appr
            if (a.name < b.name) return -1
            if (a.name > b.name) return 1
            return 0
        })
        const notJailed = chain.filterMaster(all, headHeight).filter(l => !leaderHealth.isJailed(l.name, headHeight))
        return notJailed.slice(need, need + standbyCount)
    },

    minerSchedule: (block) => {
        let hash = block.hash
        let rand = parseInt('0x'+hash.substr(hash.length-config.leaderShufflePrecision))
        if (!p2p.recovering)
            logr.debug('Generating schedule... NRNG: ' + rand)
        let miners = chain.activeLeaderSet()
        miners = miners.sort(function(a,b) {
            if(a.name < b.name) return -1
            if(a.name > b.name) return 1
            return 0
        })
        logr.debug('Schedule leaders (' + miners.length + '): ' + miners.map(l => l.name).join(','))
        if (miners.length === 0) {
            // No eligible leader: a schedule cannot be built. Return an empty
            // shuffle — consensus.activeLeaders() and minerWorker() both handle it
            // (clean halt) — instead of padding with `undefined`, which crashed
            // every node with "Cannot read properties of undefined (reading 'name')".
            logr.error('minerSchedule: active leader set is empty at height ' + block._id
                + ' — no leader can produce')
            consensus.observer = false
            return { block: block, shuffle: [] }
        }
        let shuffledMiners = []
        while (miners.length > 0) {
            let i = rand%miners.length
            shuffledMiners.push(miners[i])
            miners.splice(i, 1)
        }
        
        let y = 0
        while (shuffledMiners.length < config.leaders) {
            shuffledMiners.push(shuffledMiners[y % shuffledMiners.length])
            y++
        }

        // reset observer flag so nodes can re-evaluate their active status
        consensus.observer = false

        return {
            block: block,
            shuffle: shuffledMiners
        }
    },
    generateLeaders: (withLeaderPub, withWs, limit, start) => {
        let leaders = []
        let leaderAccs = withLeaderPub ? cache.leaders : cache.accounts
        Object.keys(leaderAccs).forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(leaderAccs, key)) return
            if (!cache.accounts[key] || !cache.accounts[key].node_appr || cache.accounts[key].node_appr <= 0)
                return
            if (withLeaderPub && !cache.accounts[key].pub_leader)
                return
            let leader = cache.accounts[key]
            let leaderDetails = {
                name: leader.name,
                pub: leader.pub,
                pub_leader: leader.pub_leader,
                balance: leader.balance,
                approves: leader.approves,
                node_appr: leader.node_appr,
            }
            if (withWs && leader.json && leader.json.node && typeof leader.json.node.ws === 'string')
                leaderDetails.ws = leader.json.node.ws
            leaders.push(leaderDetails)
        })
        // Canonical, deterministic ordering: approval descending, then name
        // ascending. The name tie-break is essential (F6): equal node_appr
        // entries previously kept the input order (cache / Mongo insertion
        // order), which differs between nodes and makes minerSchedule() build a
        // different shuffle on each one — nodes then disagree on who the round
        // leader is and produce different blocks.
        leaders = leaders.sort(function(a,b) {
            if (b.node_appr !== a.node_appr) return b.node_appr - a.node_appr
            if (a.name < b.name) return -1
            if (a.name > b.name) return 1
            return 0
        })
        return leaders.slice(start, limit)
    },
    leaderRewards: (name, ts, cb) => {
        // rewards leaders with 'free' voting power in the network
        cache.findOne('accounts', {name: name}, function(err, account) {
            let newBalance = account.balance + config.leaderReward
            let newVt = new GrowInt(account.vt, {growth:account.balance/(config.vtGrowth)}).grow(ts)
            let newBw = new GrowInt(account.bw, {
                growth: Math.max(account.baseBwGrowth || 0, account.balance)/(config.bwGrowth),
                max: config.bwMax
            }).grow(ts)
            if (!newVt || !newBw) 
                logr.debug('error growing grow int', account, ts)
            
            if (config.leaderRewardVT)
                newVt.v += config.leaderRewardVT

            if (config.leaderReward > 0 || config.leaderRewardVT > 0)
                cache.updateOne('accounts', 
                    {name: account.name},
                    {$set: {
                        vt: newVt,
                        bw: newBw,
                        balance: newBalance
                    }},
                    function(err) {
                        if (err) throw err
                        if (config.leaderReward > 0)
                            transaction.adjustNodeAppr(account, config.leaderReward, function() {
                                cb(config.leaderReward)
                            })
                        else
                            cb(0)
                    }
                )
            else cb(0)
        },true)
    },
    decayBurnAccount: (block) => {
        return new Promise((rs) => {
            if (!config.burnAccount || config.burnAccountIsBlackhole || block._id % config.ecoBlocks !== 0)
                return rs(0)
            // offset inflation
            let rp = eco.rewardPool()
            let burnAmount = Math.floor(rp.dist)
            if (burnAmount <= 0)
                return rs(0)
            cache.findOne('accounts', {name: config.burnAccount}, (e,burnAccount) => {
                // do nothing if there is none to burn
                if (burnAccount.balance <= 0)
                    return rs(0)
                // burn only up to available balance
                burnAmount = Math.min(burnAmount,burnAccount.balance)
                cache.updateOne('accounts', {name: config.burnAccount}, {$inc: {balance: -burnAmount}},() =>
                    transaction.updateGrowInts(burnAccount, block.timestamp, () => {
                        transaction.adjustNodeAppr(burnAccount, -burnAmount, () => {
                            logr.econ('Burned ' + burnAmount + ' periodically from ' + config.burnAccount)
                            return rs(burnAmount)
                        })
                    })
                )
            })
        })
    },
    calculateHashForBlock: (block,deleteExisting) => {
        if (config.blockHashSerialization === 1)
            return chain.calculateHashV1(block._id, block.phash, block.timestamp, block.txs, block.miner, block.missedBy, block.dist, block.burn)
        else if (config.blockHashSerialization === 2) {
            let clonedBlock
            if (deleteExisting) {
                clonedBlock = cloneDeep(block)
                delete clonedBlock.hash
                delete clonedBlock.signature
            }
            return crypto.createHash('sha256').update(JSON.stringify(deleteExisting ? clonedBlock : block)).digest('hex')
        }
    },
    calculateHashV1: (index, phash, timestamp, txs, miner, missedBy, distributed, burned) => {
        let string = index + phash + timestamp + txs + miner
        if (missedBy) string += missedBy
        if (distributed) string += distributed
        if (burned) string += burned

        return crypto.createHash('sha256').update(string).digest('hex')
    },    
    getLatestBlock: () => {
        return chain.recentBlocks[chain.recentBlocks.length-1]
    },    
    getFirstMemoryBlock: () => {
        return chain.recentBlocks[0]
    },
    cleanMemory: () => {
        chain.cleanMemoryBlocks()
        chain.cleanMemoryTx()
        eco.cleanHistory()
    },
    cleanMemoryBlocks: () => {
        if (config.ecoBlocksIncreasesSoon) {
            logr.trace('Keeping old blocks in memory because ecoBlocks is changing soon')
            if (chain.recentBlocks.length > config.ecoBlocks * 2) {
                let overflow = chain.recentBlocks.length - config.ecoBlocks * 2
                while (overflow > 0) {
                    chain.recentBlocks.shift()
                    overflow--
                }
            }
            return
        }
            
        let extraBlocks = chain.recentBlocks.length - config.ecoBlocks
        while (extraBlocks > 0) {
            chain.recentBlocks.shift()
            extraBlocks--
        }
    },
    cleanMemoryTx: () => {
        Object.keys(chain.recentTxs).forEach(hash => {
            if (chain.recentTxs[hash].ts + config.txExpirationTime < chain.getLatestBlock().timestamp)
                delete chain.recentTxs[hash]
        })
    },
    applyHardfork: (block,cb) => {
        // Do something on hardfork block after tx executions and before leader rewards distribution
        // As this is not a real transaction, no actual transaction is considered executed here
        if (block._id === 17150000)
            // Clear @dtube.airdrop account
            cache.findOne('accounts', {name: config.burnAccount}, (e,burnAccount) => {
                let burned = burnAccount.balance
                cache.updateOne('accounts',
                    {name: config.burnAccount},
                    {$set: {
                        balance: 0,
                        bw: { v: 0, t: block.timestamp },
                        vt: { v: 0, t: block.timestamp }
                    }}, () => cb(null, { executed: false, distributed: 0, burned: burned })
                )
            })
        else
            cb(null, { executed: false, distributed: 0, burned: 0 })
    },
    applyHardforkPostBlock: (blockNum) => {
        // Do something after executing hardfork block
        if (blockNum === 4860000)
            eco.loadHistory() // reset previous votes
    },
    // Rebuild leaderHealth from the last N finalised blocks (startup path).
    //
    // Jail/streak/absence are DERIVED state: a node that restarts with an empty
    // leaderHealth would compute a different activeLeaderSet (jailed leaders
    // back in rotation) than its peers, i.e. a different schedule and a
    // different shuffle — a fork. A full blockchain rebuild gets this for free
    // (processBlock runs on every block); this bounded scan covers the resume
    // path. Window: the longest possible jail (jailBlocks * 2^(backoffMax-1))
    // plus enough blocks to accumulate jailMissThreshold skips.
    leaderHealthRebuildBlocks: (function () {
        const jailBlocks = config.jailBlocks || 200
        const backoff = config.jailBackoffMax || 4
        const threshold = config.jailMissThreshold || 30
        return Math.max(2200, jailBlocks * Math.pow(2, backoff - 1) + threshold * (config.leaders || 5) + 200)
    })(),
    rebuildLeaderHealth: (cb) => {
        const head = chain.getLatestBlock()._id
        const count = chain.leaderHealthRebuildBlocks
        const from = Math.max(1, head - count + 1)
        leaderHealth.leaders = {}
        if (head < 1) return cb(null, 0)
        const fold = (bs) => {
            for (let i = 0; i < bs.length; i++)
                leaderHealth.processBlock(bs[i], null)
            cb(null, bs.length)
        }
        if (blocks.isOpen) {
            let range
            try {
                range = blocks.readRange(from, head) || []
            } catch (e) {
                return cb(e)
            }
            return fold(range)
        }
        db.collection('blocks').find({_id: { $gte: from, $lte: head }}).sort({_id: 1}).toArray((e, bs) => {
            if (e) return cb(e)
            fold(bs || [])
        })
    },
    batchLoadBlocks: (blockNum,cb) => {
        if (chain.blocksToRebuild.length === 0)
            if (blocks.isOpen) {
                chain.blocksToRebuild = blocks.readRange(blockNum, blockNum+max_batch_blocks-1)
                cb(chain.blocksToRebuild.shift())
            } else
                db.collection('blocks').find({_id: { $gte: blockNum, $lt: blockNum+max_batch_blocks }}).toArray((e,loadedBlocks) => {
                    if (e) throw e
                    if (loadedBlocks) chain.blocksToRebuild = loadedBlocks
                    cb(chain.blocksToRebuild.shift())
                })
        else cb(chain.blocksToRebuild.shift())
    },
    rebuildState: (blockNum,cb) => {
        // If chain shutting down, stop rebuilding and output last number for resuming
        if (chain.shuttingDown)
            return cb(null,blockNum)
            
        // Genesis block is handled differently
        if (blockNum === 0) {
            eco.history = [{_id: 0, votes: 0, cDist: 0, cBurn: 0}]
            chain.recentBlocks = [chain.getGenesisBlock()]
            chain.schedule = chain.minerSchedule(chain.getGenesisBlock())
            chain.saveSchedule()
            chain.rebuildState(blockNum+1,cb)
            return
        }

        chain.batchLoadBlocks(blockNum, async (blockToRebuild) => {
            if (!blockToRebuild)
                // Rebuild is complete
                return cb(null,blockNum)
            
            // Validate block and transactions, then execute them
            if (process.env.REBUILD_NO_VALIDATE !== '1') {
                let isValidBlock = await chain.isValidNewBlockPromise(blockToRebuild,true,false)
                if (!isValidBlock)
                    return cb(true, blockNum)
            }
            chain.executeBlockTransactions(blockToRebuild,false,(validTxs,dist,burn) => {
                // if any transaction is wrong, thats a fatal error
                // matching consensus validation: skip revalidation, trust miner
                if (blockToRebuild.txs.length !== validTxs.length) {
                    logr.fatal('Invalid tx(s) in block found after starting execution')
                    return cb('Invalid tx(s) in block found after starting execution', blockNum)
                }

                // error if distributed or burned computed amounts are different than the reported one
                let blockDist = blockToRebuild.dist || 0
                if (blockDist !== dist)
                    return cb('Wrong dist amount ' + blockDist + ' ' + dist, blockNum)

                let blockBurn = blockToRebuild.burn || 0
                if (blockBurn !== burn) 
                    return cb('Wrong burn amount ' + blockBurn + ' ' + burn, blockNum)
                
                // update the config if an update was scheduled
                chain.addRecentTxsInBlock(blockToRebuild.txs)
                Object.assign(config, require('./config.js').read(blockToRebuild._id))
                chain.applyHardforkPostBlock(blockToRebuild._id)
                dao.nextBlock()
                daoMaster.nextBlock()
                eco.nextBlock()
                eco.appendHistory(blockToRebuild)
                chain.cleanMemory()
                leaderHealth.processBlock(blockToRebuild, chain.schedule)
                leaderStats.processBlock(blockToRebuild)
                txHistory.processBlock(blockToRebuild)

                let writeInterval = parseInt(process.env.REBUILD_WRITE_INTERVAL)
                if (isNaN(writeInterval) || writeInterval < 1)
                    writeInterval = 10000

                cache.processRebuildOps(() => {
                    if (blockToRebuild._id % config.leaders === 0) {
                        chain.schedule = chain.minerSchedule(blockToRebuild)
                        chain.saveSchedule()
                    }
                    chain.recentBlocks.push(blockToRebuild)
                    chain.output(blockToRebuild, true)
                    
                    // process notifications and leader stats (non blocking)
                    notifications.processBlock(blockToRebuild)

                    // next block
                    chain.rebuildState(blockNum+1, cb)
                }, blockToRebuild._id % writeInterval === 0)
            })
        })
    }
}

module.exports = chain
