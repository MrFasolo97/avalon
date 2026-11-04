const secp256k1 = require('secp256k1')
const crypto = require('crypto')
const bs58 = require('base-x')(config.b58Alphabet)
const cloneDeep = require('clone-deep')
const consensusQuorum = require('./consensusQuorum')
const voteState = require('./voteState')
const leaderHealth = require('./leaderHealth')

// all p2p.sockets referenced here are verified nodes with a node_status

const FF_BACKOFF_MS = [600, 1200, 2400, 4800]

// S0' shadow mode: observe every vote in the ledger and compare the ledger's
// verdict with the production one. Never refuses anything. Off by default.
const QC_SHADOW = process.env.QC_SHADOW === '1'
const VOTE_STATE_PATH = process.env.VOTE_STATE_PATH || './state/vote_state.json'

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
    ffVote: null,
    ffMonotoneRejects: 0,
    haltBreakerTimeout: null,
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
    // === Layer S/H: quorum-eligible leader set ===
    // Today (quorumEligibility = 'activeLeaders') this is the same as activeLeaders().
    // At H_S it becomes 'lastTurn': a leader is only counted if it has had a scheduled
    // turn in the current epoch and is not jailed. The fallback keeps genesis working.
    eligibleLeaders: (h) => {
        const active = consensus.activeLeaders()
        if (config.quorumEligibility !== 'lastTurn') return active
        // F2: base the quorum set on the chain-derived epoch rotation
        // (chain.activeLeaderSet(), identical on every node) instead of the local
        // activeLeaders() view, so the denominator cannot differ by a block
        // between nodes. That node-local denominator made the quorum threshold
        // differ across nodes (q=3 vs q=4) and split the network after a total
        // halt (F2, drills G10/G11).
        //
        // Exception — the genesis transition: the master (`config.masterName`) is
        // the scheduled leader until `leaders` real candidates exist, and it must
        // stay eligible or the fresh chain deadlocks at the first epoch after the
        // miners are voted in (the stale master schedule cannot be regenerated
        // because the block that would regenerate it is the one being blocked).
        // While the master is still in the epoch shuffle, keep the historical
        // activeLeaders() behaviour; switch to the deterministic rotation once it
        // has left.
        const masterStillScheduled = !chain.schedule || !chain.schedule.shuffle
            || chain.schedule.shuffle.some(s => s && s.name === config.masterName)
        let base = active
        if (!masterStillScheduled && typeof chain.activeLeaderSet === 'function') {
            const set = chain.activeLeaderSet().map(l => l.name || l)
            if (set.length) base = set
        }
        const eligible = base.filter(name => leaderHealth.isEligible(name, h))
        if (eligible.length === 0) return base
        return eligible
    },
    // Observes votes and compares the ledger verdict with the production one.
    // Nothing here can refuse, delay or alter a block: read the counters, act
    // on them, then ship S1'.
    qc: {
        enabled: QC_SHADOW,
        // singleVote: false — see qcObserve(): the ledger must mirror the
        // protocol it is measuring, not an invariant the protocol lacks.
        ledger: consensusQuorum.createLedger({ singleVote: false }),
        eligible: [],
        eligibleHeight: -1,
        checked: 0,
        divergences: 0,
        unsafe: 0,
        late: 0,
        thresholdMismatches: 0,
        equivocations: 0,
        ffConflicts: 0,
        voteStateFailures: 0,
        voteStateRefusals: 0,
        internalErrors: 0,
        phantomVotes: 0,
        unobservedVotes: 0,
        justifyVerified: 0,
        justifyInvalid: 0,
        justifyQCs: 0,
        // signed round-0 votes we have seen, so a round-1 vote can carry the
        // round-0 QC as a verifiable `justify` (doc §2.5). "h:r" -> hash ->
        // signer -> { n, s, ts }
        qcVotes: new Map(),
        thresholdLoggedHeight: -1,
        divergenceLoggedHeight: -1,
        ffThresholdLoggedHeight: -1,
        equivocationLoggedHeight: -1
    },
    // S0' contract: shadow code can never refuse, delay or alter anything —
    // including by throwing. A bug in the observer must degrade to a log line,
    // never to a dead node (learned the hard way on the first testnet run).
    qcGuard: (label, fn) => {
        if (!consensus.qc.enabled) return null
        try {
            return fn()
        } catch (e) {
            consensus.qc.internalErrors++
            logr.error('QC-INTERNAL-ERROR '+label+': '+e.message+' (shadow only, block path unaffected)')
            return null
        }
    },
    qcHeightOf: (block) => {
        if (!block) return -1
        if (Number.isInteger(block._id)) return block._id
        // votes for blocks we only know by hash: recover the height locally
        for (let i = 0; i < consensus.possBlocks.length; i++)
            if (consensus.possBlocks[i].block.hash === block.hash
            && Number.isInteger(consensus.possBlocks[i].block._id))
                return consensus.possBlocks[i].block._id
        return -1
    },
    qcEligible: (h) => {
        // S0' fallback = today's activeLeaders(), canonically sorted. Step H
        // replaces this with a skips[]-derived set (plan Layer S/H).
        if (consensus.qc.eligibleHeight !== h) {
            consensus.qc.eligible = consensusQuorum.canonicalEligible(consensus.activeLeaders())
            consensus.qc.eligibleHeight = h
        }
        return consensus.qc.eligible
    },
    qcObserve: (h, round, hash, signer) => {
        if (!consensus.qc.enabled) return
        if (!Number.isInteger(h) || h < 0) return
        if (typeof hash !== 'string' || hash.length === 0) return
        if (typeof signer !== 'string' || signer.length === 0) return

        // singleVote is off: the ledger must mirror what the chain does. Avalon
        // votes on EVERY candidate block at a height, so one hash per
        // (height, phase) is not a property of this protocol. Refusing those
        // votes would under-count and report divergences that do not exist;
        // instead they are counted here as a protocol property (see doc §4.2).
        const res = consensusQuorum.recordVote(consensus.qc.ledger, { h, r: round, hash, signer })
        if (!res.accepted) return
        if (res.reason === 'equivocation') {
            consensus.qc.equivocations++
            if (consensus.qc.equivocationLoggedHeight !== h) {
                consensus.qc.equivocationLoggedHeight = h
                logr.info('QC-EQUIVOCATION height '+h+' phase '+round+' by '+signer
                    +': '+(res.previous||'?').substr(0,8)+' -> '+hash.substr(0,8)
                    +' (multi-candidate height: INV-1 would refuse this vote)')
            }
        } else if (res.reason === 'lock-conflict')
            logr.debug('QC-LOCK-CONFLICT height '+h+' by '+signer+' (locked on '+(res.locked||'?').substr(0,8)+')')
    },
    // S0': retain the signed round-0 votes we observed so a round-1 vote can
    // carry the round-0 QC as a `justify` a peer can verify without having been
    // online for round 0 (doc §2.5). Only compact (hash-only) votes are kept: a
    // miner's own round-0 vote carries the whole block and the block itself is
    // already on the wire, so it is not needed to prove the QC.
    qcRememberVote: (h, round, hash, signer, message) => {
        if (!consensus.qc.enabled) return
        if (!Number.isInteger(h) || h < 0) return
        if (typeof hash !== 'string' || hash.length === 0) return
        if (typeof signer !== 'string' || signer.length === 0) return
        if (!message || !message.d || !message.s || !message.s.s) return
        // only votes that already carry the explicit height can be rebuilt
        if (!Number.isInteger(message.d.h)) return
        if (!message.d.b || typeof message.d.b.hash !== 'string') return
        if (message.d.b._id !== undefined) return
        const key = h + ':' + round
        let byHash = consensus.qc.qcVotes.get(key)
        if (!byHash) {
            byHash = new Map()
            consensus.qc.qcVotes.set(key, byHash)
        }
        let bySigner = byHash.get(hash)
        if (!bySigner) {
            bySigner = new Map()
            byHash.set(hash, bySigner)
        }
        if (!bySigner.has(signer))
            bySigner.set(signer, { n: signer, s: message.s.s, ts: message.d.ts })
    },
    qcBuildJustify: (h, round, hash) => {
        const byHash = consensus.qc.qcVotes.get(h + ':' + round)
        const bySigner = byHash && byHash.get(hash)
        if (!bySigner) return null
        const q = consensusQuorum.quorumSize(consensus.qcEligible(h).length)
        const out = []
        for (const entry of bySigner.values()) {
            out.push(entry)
            if (Number.isFinite(q) && out.length >= q) break
        }
        return out.length ? out : null
    },
    // Re-verify a `justify` carried by a round-1 vote: signature, height, phase,
    // hash and eligible membership, then count distinct signers. Freshness is
    // NOT applied to justify entries (they were produced before the round-1 vote
    // and would be dropped as stale — doc §2.5).
    qcVerifyJustify: (h, phase, hash, justify, eligible) => {
        if (!consensus.qc.enabled) return
        if (!Array.isArray(justify) || justify.length === 0) return
        const set = new Set(eligible || consensus.qcEligible(h))
        const seen = new Set()
        let accepted = 0
        for (const entry of justify) {
            if (!entry || typeof entry.n !== 'string' || typeof entry.s !== 'string') {
                consensus.qc.justifyInvalid++
                continue
            }
            if (!Number.isFinite(entry.ts) || entry.ts <= 0) {
                consensus.qc.justifyInvalid++
                continue
            }
            if (seen.has(entry.n) || !set.has(entry.n)) {
                consensus.qc.justifyInvalid++
                continue
            }
            seen.add(entry.n)
            const rebuilt = {
                t: 6,
                d: { r: phase, b: { hash: hash }, ts: entry.ts, h: h },
                s: { n: entry.n, s: entry.s, v: config.consensusSigVersion || 1 }
            }
            let ok = false
            consensus.verifySignature(rebuilt, (v) => { ok = v })
            if (!ok) {
                consensus.qc.justifyInvalid++
                continue
            }
            accepted++
            consensus.qc.justifyVerified++
            consensus.qcObserve(h, phase, hash, entry.n)
        }
        const q = consensusQuorum.quorumSize(set.size)
        if (accepted > 0 && Number.isFinite(q) && accepted >= q) {
            consensus.qc.justifyQCs++
            logr.info('QC-JUSTIFY height '+h+'#'+hash.substr(0, 8)+' phase '+phase
                +': verified '+accepted+'/'+q+' signatures carried by the peer vote')
        }
    },
    qcNoteOwnVote: (h, round, hash) => {
        if (!consensus.qc.enabled) return
        if (!Number.isInteger(h) || h < 0) return
        if (typeof hash !== 'string' || hash.length === 0) return

        try {
            const prev = voteState.load(VOTE_STATE_PATH)
            const verdict = voteState.decide(prev.record, { height: h, round: round, hash: hash })
            if (!verdict.allow) {
                // shadow: still send the vote, but this is exactly what S1'
                // will refuse
                consensus.qc.voteStateRefusals++
                if (verdict.reason === 'stale-height')
                    // expected after a cache.rollback: S1' must reset the file
                    // explicitly, never infer a rollback from the record
                    logr.warn('QC-VOTE-STATE behind head at '+h+'/'+round
                        +' (recorded '+prev.record.height+'): vote state needs reset after a rollback (shadow: vote still sent)')
                else if (verdict.reason === 'equivocation') {
                    // the protocol votes on several candidates at one height,
                    // so this is the normal case, not a defect (doc §4.2)
                    if (consensus.qc.equivocationLoggedHeight !== h) {
                        consensus.qc.equivocationLoggedHeight = h
                        logr.info('QC-VOTE-STATE would refuse own vote at '+h+'/'+round
                            +'#'+hash.substr(0,8)+': another candidate at this height'
                            +' (shadow: vote still sent)')
                    }
                } else
                    logr.debug('QC-VOTE-STATE would refuse own vote at '+h+'/'+round+'#'
                        +hash.substr(0,8)+': '+verdict.reason+' (shadow: vote still sent)')
                return
            }
            voteState.saveVerified(VOTE_STATE_PATH, { height: h, round: round, hash: hash })
        } catch (e) {
            consensus.qc.voteStateFailures++
            logr.error('QC-VOTE-STATE write failed: '+e.message+' (shadow: vote still sent)')
        }
    },
    qcCompare: (h, round, hash, productionCount, threshold, roundSigners) => {
        if (!consensus.qc.enabled) return null
        if (!Number.isInteger(h) || h < 0) return null
        if (typeof hash !== 'string' || hash.length === 0) return null

        consensus.qc.checked++
        // ledger is per-height: drop what we can never vote on again
        consensusQuorum.pruneLedger(consensus.qc.ledger, h - 2)
        // same bound for the retained signed votes used to build `justify`
        for (const key of Array.from(consensus.qc.qcVotes.keys())) {
            const kh = Number(key.split(':')[0])
            if (Number.isInteger(kh) && kh < h - 2) consensus.qc.qcVotes.delete(key)
        }

        const eligible = consensus.qcEligible(h)
        const unified = consensusQuorum.quorumSize(eligible.length)

        if (Number.isFinite(threshold) && threshold !== unified
        && consensus.qc.thresholdLoggedHeight !== h) {
            consensus.qc.thresholdLoggedHeight = h
            consensus.qc.thresholdMismatches++
            logr.warn('QC-THRESHOLD-DIVERGENCE height '+h+': production '+threshold
                +' vs unified '+unified+' (n='+eligible.length+')')
        }

        const cmp = consensusQuorum.compareDecision({
            productionCount: productionCount,
            threshold: threshold,
            ledger: consensus.qc.ledger,
            h: h,
            r: round,
            hash: hash,
            eligible: eligible
        })

        if (cmp.divergence) {
            consensus.qc.divergences++
            if (cmp.unsafe) consensus.qc.unsafe++
            if (cmp.late) consensus.qc.late++
            if (consensus.qc.divergenceLoggedHeight !== h) {
                consensus.qc.divergenceLoggedHeight = h
                const cause = consensus.qcDivergenceCause(h, round, hash, eligible, roundSigners)
                if (cause.phantom) consensus.qc.phantomVotes++
                if (cause.unobserved) consensus.qc.unobservedVotes++
                logr.warn('QC-DIVERGENCE height '+h+'#'+hash.substr(0,8)
                    +' phase '+round
                    +' production '+cmp.productionCount+'/'+cmp.threshold
                    +' vs ledger '+cmp.qcCount+'/'+cmp.quorum
                    +(cmp.unsafe ? ' (production would finalise without a QC)' : ' (QC reached, production late)')
                    +cause.text)
            }
        }

        if (consensus.qc.checked % 2000 === 0)
            logr.info('QC-SHADOW checked '+consensus.qc.checked
                +' divergences '+consensus.qc.divergences
                +' (unsafe '+consensus.qc.unsafe+', late '+consensus.qc.late+')'
                +' causes: phantom '+consensus.qc.phantomVotes
                +', unobserved '+consensus.qc.unobservedVotes
                +' threshold mismatches '+consensus.qc.thresholdMismatches
                +' equivocations '+consensus.qc.equivocations)

        return cmp
    },
    // Why production and the ledger disagree. This is the whole point of S0':
    // the counters are only useful if the cause is named, because the two
    // causes have opposite fixes.
    qcDivergenceCause: (h, round, hash, eligible, roundSigners) => {
        const names = Array.isArray(roundSigners) ? roundSigners : []
        if (names.length === 0) return { text: '', phantom: false, unobserved: false }

        const received = consensusQuorum.signersForHash(consensus.qc.ledger, h, round, hash)

        // counted by production but not eligible: an observer counts its own
        // vote locally even though it never broadcasts it
        const phantom = names.filter(n => eligible.indexOf(n) === -1)
        // eligible, but its vote never reached us: a local push with no message
        const unobserved = names.filter(n => eligible.indexOf(n) !== -1 && !received.has(n))

        const parts = []
        if (phantom.length) parts.push('counted but not eligible: ' + phantom.join(','))
        if (unobserved.length) parts.push('eligible votes never received: ' + unobserved.join(','))

        return {
            text: parts.length ? ' — ' + parts.join('; ') : '',
            phantom: phantom.length > 0,
            unobserved: unobserved.length > 0
        }
    },
    tryNextStepBusy: false,
    tryNextStepScheduled: false,
    tryNextStep: () => {
        if (consensus.finalizing || consensus.tryNextStepBusy) {
            // Coalesce the retry into ONE pending timer. Without this, every
            // re-entrant call inside a single pass schedules its own 100ms timer
            // (round -> endRound -> tryNextStep), so under a stall the number of
            // pending tryNextStep timers grows multiplicatively and floods the
            // event loop: the node spams "T<n> R0-.. R1-.." and its HTTP API
            // stops answering (seen on G5).
            if (!consensus.tryNextStepScheduled) {
                consensus.tryNextStepScheduled = true
                setTimeout(() => {
                    consensus.tryNextStepScheduled = false
                    consensus.tryNextStep()
                }, 100)
            }
            return
        }
        consensus.tryNextStepBusy = true
        try {
            let consensus_size = consensus.eligibleLeaders(chain.getLatestBlock()._id + 1).length
            // Smallest integer STRICTLY above 2/3 (floor+1), with the minimum
            // floor capped by the signers that exist: see blockQuorum().
            let threshold = consensusQuorum.blockQuorum(consensus_size, config.quorumMin)

            // S0' compares against the same threshold (the observer +1 hack was
            // a workaround for counting the observer's own non-broadcast vote;
            // after the endRound fix that vote is no longer counted, so the
            // penalty is removed — see doc §4.2).
            const qcThreshold = threshold

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

            // An elected leader must have precommitted the block (its own name is
            // in round 0, pushed by endRound()). A non-voting node (observer, or a
            // backup that is not in the current shuffle) has no name there and must
            // still finalise on the QC alone: requiring its own vote stalled every
            // non-leader node from following the chain (doc §2.5).
            const selfIsActive = consensus.isActive()
            for (let i = 0; i < consensus.possBlocks.length; i++) {
                const possBlock = consensus.possBlocks[i]
                logr.cons('T'+Math.ceil(threshold)+' R0-'+(possBlock[0]?possBlock[0].length:'?')+' R1-'+(possBlock[1]?possBlock[1].length:'?'))
                // S0' shadow: same decision, computed by the ledger
                if (Number.isInteger(possBlock.block._id))
                    consensus.qcGuard('compare', () => {
                        const lastRound = possBlock[config.consensusRounds-1]
                        consensus.qcCompare(possBlock.block._id, config.consensusRounds-1,
                            possBlock.block.hash, lastRound.length, qcThreshold, lastRound)
                    })
                // if 2/3+ of the final round and not already finalizing another block
                const selfPrecommitted = possBlock[0] && possBlock[0].indexOf(process.env.NODE_OWNER) !== -1
                if (possBlock[config.consensusRounds-1].length >= threshold 
            && !consensus.finalizing 
            && possBlock.block._id === chain.getLatestBlock()._id+1
            && (selfIsActive ? selfPrecommitted : true)) {
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

            // A malformed NEW_BLOCK can arrive with no hash; everything below
            // assumes one (block.hash.substr, possBlocks/validating keys). Refuse
            // it instead of throwing: an unhandled throw here crashed the node
            // and, through the P2P relay, took down half the network mid-drill.
            if (!block.hash || typeof block.hash !== 'string') {
                if (cb) cb(0)
                return
            }

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
                    if (cb) cb(-1)
                } else {
                    logr.cons('Precommitting block '+block._id+'#'+block.hash.substr(0,4))

                    // adding to possible blocks
                    if (consensus.possBlocks.length >= consensus.activeLeaders().length * 2)
                        logr.warn('possBlocks at capacity, not adding new block')
                    else
                        consensus.possBlocks.push(possBlock)
                    if (config.forceFinalize)
                        consensus.scheduleForceFinalize()
                    // adding ourselves to precommit list
                    // now done inside endRound(), only when the vote is actually
                    // broadcast, so an observer never counts its own local vote
                    // (doc §4.2)

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
        } else
            // commit stage
            for (let b = 0; b < consensus.possBlocks.length; b++) 
                if (consensus.possBlocks[b].block.hash === block.hash) {
                    // own vote is recorded and broadcast by endRound(); if we are
                    // an observer we must not count it locally (doc §4.2)
                    consensus.endRound(round, block)
                    break
                }
    },
    endRound: (round, block) => {
        // A vote is only real if it is broadcast (or, for ourselves, at least
        // added to the tally as if it had been received). The old code added the
        // node's own name in several places without always broadcasting it,
        // which made the quorum partly local: see doc §4.2.
        if (consensus.isActive()) {
            // find the possBlock entry for this hash and record our own vote
            for (let i = 0; i < consensus.possBlocks.length; i++)
                if (consensus.possBlocks[i].block.hash === block.hash
                && consensus.possBlocks[i][round].indexOf(process.env.NODE_OWNER) === -1)
                    consensus.possBlocks[i][round].push(process.env.NODE_OWNER)

            // signing and broadcast to our peers
            // only if we are an active leader
            let onlyBlockHash = {
                hash: block.hash
            }
            if (block.miner === process.env.NODE_OWNER && round === 0)
                onlyBlockHash = block

            // S0' shadow: persist the vote BEFORE it leaves the process (§2.7)
            // and record it in the ledger. Only votes we actually broadcast.
            const qcH = consensus.qc.enabled ? consensus.qcHeightOf(block) : -1
            consensus.qcGuard('own-vote', () => {
                consensus.qcNoteOwnVote(qcH, round, block.hash)
                consensus.qcObserve(qcH, round, block.hash, process.env.NODE_OWNER)
            })

            // QC on the wire (doc §2.5): send the explicit height, and on the
            // commit vote attach the round-0 QC as a verifiable `justify`.
            let msgD = { r: round, b: onlyBlockHash, ts: new Date().getTime() }
            if (consensus.qc.enabled) {
                msgD.h = qcH
                if (round === consensusQuorum.COMMIT) {
                    const justify = consensus.qcBuildJustify(qcH, consensusQuorum.PRECOMMIT, block.hash)
                    if (justify) msgD.justify = justify
                }
            }
            let signed = consensus.signMessage({ t: 6, d: msgD })
            if (consensus.qc.enabled && round === consensusQuorum.PRECOMMIT)
                consensus.qcGuard('remember-own', () => {
                    consensus.qcRememberVote(qcH, round, block.hash, process.env.NODE_OWNER, signed)
                })
            p2p.broadcast(signed)
        }

        // try to move to next consensus step
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
                const qcH = Number.isInteger(message.d.h) ? message.d.h
                    : (Number.isInteger(consensus.possBlocks[i].block._id) ? consensus.possBlocks[i].block._id : -1)
                // S0' shadow: count the remote vote before the duplicate early-exit
                consensus.qcGuard('remote-vote', () => {
                    consensus.qcObserve(qcH, round, block.hash, leader)
                })
                // QC on the wire (doc §2.5): a commit vote may carry the round-0
                // QC as `justify`; verify it and retain the signed vote.
                consensus.qcGuard('remote-justify', () => {
                    if (round === consensusQuorum.COMMIT && Array.isArray(message.d.justify))
                        consensus.qcVerifyJustify(qcH, consensusQuorum.PRECOMMIT, block.hash, message.d.justify)
                    // only round-0 votes are needed to build a `justify`
                    if (round === consensusQuorum.PRECOMMIT)
                        consensus.qcRememberVote(qcH, round, block.hash, leader, message)
                })

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
    findPossBlockByHash: (hash) => {
        if (!hash) return null
        for (let i = 0; i < consensus.possBlocks.length; i++)
            if (consensus.possBlocks[i].block.hash === hash)
                return consensus.possBlocks[i]
        return null
    },
    ffBlockOf: (height, hash) => {
        const pb = consensus.findPossBlockByHash(hash)
        if (pb && pb.block._id === height) return pb.block
        const props = consensus.ffProposals && consensus.ffProposals.proposals
        if (props && props[hash] && props[hash].block._id === height) return props[hash].block
        return null
    },
    // true iff hashA has a strictly better (lower) chain rank than hashB at this
    // height. Enforces monotone force-finalize votes (doc §5.5.3): a node may
    // only move its FF vote towards a better candidate, never away, which stops
    // the "each node votes for its own local winner" oscillation.
    ffBetter: (height, hashA, hashB) => {
        if (!hashA || !hashB || hashA === hashB) return false
        const a = consensus.ffBlockOf(height, hashA)
        const b = consensus.ffBlockOf(height, hashB)
        if (!a || !b) return false
        return chain.compareBlockRank(chain.deriveBlockRank(a), chain.deriveBlockRank(b)) < 0
    },
    requestForceFinalizeBlocks: (height, hashes) => {
        if (!p2p || !p2p.broadcast || !Array.isArray(hashes) || hashes.length === 0) return
        const missing = hashes.filter(h => !consensus.findPossBlockByHash(h))
        if (missing.length === 0) return
        logr.debug('FF_FETCH requesting ' + missing.length + ' candidate block(s) for height ' + height)
        p2p.broadcast({ t: 8, d: { height, hashes: missing } })
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
        const senderHashes = Array.isArray(message.d.hashes) ? message.d.hashes : []
        if (!hash && senderHashes.length > 0) {
            // Pick best local match from the sender's candidate list
            const local = consensus.possBlocks.filter(pb =>
                pb.block._id === message.d.height
                && senderHashes.indexOf(pb.block.hash) !== -1
            )
            local.sort((a, b) => chain.compareBlockRank(chain.deriveBlockRank(a.block), chain.deriveBlockRank(b.block)))
            hash = local[0] && local[0].block.hash

            // Fetch any candidate hashes we do not have yet so that we can
            // evaluate them on equal footing with our local winner.
            if (p2p && p2p.broadcast)
                consensus.requestForceFinalizeBlocks(message.d.height, senderHashes)
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

        // Monotone votes (doc §5.5.3): a peer may only move its FF vote towards a
        // strictly better rank, never away. Ignore a re-vote for a worse block.
        const prevVote = consensus.ffProposals.respondents[sender]
        if (prevVote && prevVote !== hash && !consensus.ffBetter(message.d.height, hash, prevVote)) {
            consensus.ffMonotoneRejects++
            logr.debug('FF ignoring non-monotone re-vote from ' + sender + ' at height ' + message.d.height)
            return
        }

        // Track this respondent, and refresh the timestamp even on a repeated
        // vote: the halt breaker counts only recent votes, so that the stale
        // votes of nodes that have since gone down age out.
        if (consensus.ffProposals.respondents[sender] !== hash) {
            consensus.ffProposals.respondents[sender] = hash
            logr.cons('FF respondent: ' + sender + ' for ' + message.d.height + '#' + hash.substr(0, 8))
        }
        if (!consensus.ffProposals.respondentTs) consensus.ffProposals.respondentTs = {}
        consensus.ffProposals.respondentTs[sender] = Date.now()

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
        consensus.cancelHaltBreaker()
    },
    cancelHaltBreaker: () => {
        clearTimeout(consensus.haltBreakerTimeout)
        consensus.haltBreakerTimeout = null
    },
    scheduleHaltBreaker: () => {
        if (!config.haltBreaker) return
        if (process.env.HALT_BREAKER === '0') return
        const latestBlock = chain.getLatestBlock()
        const expectedHeight = latestBlock._id + 1
        if (consensus.haltBreakerTimeout) return
        const hasCandidate = consensus.possBlocks.some(pb => pb.block._id === expectedHeight)
        if (!hasCandidate) return
        const delay = config.haltBreakerMs || 21000
        logr.debug('Halt breaker armed in ' + delay + 'ms for height ' + expectedHeight)
        consensus.haltBreakerTimeout = setTimeout(() => {
            consensus.runHaltBreaker(expectedHeight)
        }, delay)
        if (consensus.haltBreakerTimeout.unref)
            consensus.haltBreakerTimeout.unref()
    },
    runHaltBreaker: (height) => {
        consensus.haltBreakerTimeout = null
        if (!config.haltBreaker) return
        if (process.env.HALT_BREAKER === '0') return
        if (consensus.finalizing) return
        if (height !== chain.getLatestBlock()._id + 1) return

        const eligible = consensus.eligibleLeaders(height)
        const candidates = consensus.possBlocks.filter(pb => pb.block._id === height)
        if (candidates.length === 0) {
            logr.warn('Halt breaker has no candidates for height ' + height)
            return
        }

        candidates.sort((a, b) => chain.compareBlockRank(chain.deriveBlockRank(a.block), chain.deriveBlockRank(b.block)))

        // Unanimity of the REMAINING leaders (plan §6.3.1): every node that is
        // actually reachable must sign the same candidate. A leader that cannot
        // be reached is, by definition, not represented in the chain yet, so
        // waiting for it would freeze the chain forever on a same-round double
        // death — which is exactly the case the breaker exists for.
        //
        // Fork-safety bound: firing with r respondents is safe iff the nodes
        // that did NOT respond cannot, on their own, form a competing quorum:
        //   E - r < q  =>  r > E - q
        // With E=5/q=4 that means r >= 2, and the hard floor of 3 (quorumMin)
        // keeps the breaker to "the whole remaining set".
        const now = Date.now()
        const ownName = process.env.NODE_OWNER

        // Re-broadcast the proposal on every attempt so leaders that have just
        // come back (re)vote and refresh their timestamp. Without this the
        // breaker only ever saw the stale votes of the nodes alive *before* the
        // halt and could never reach unanimity — the full-halt resume never
        // worked.
        if (chain.schedule && chain.schedule.shuffle && consensus.getActiveLeaderKey(ownName) && p2p && p2p.broadcast) {
            if (!consensus.ffProposals)
                consensus.ffProposals = { height: height, proposals: {}, respondents: {}, respondentTs: {} }
            consensus.ffProposals.height = height
            candidates.forEach(c => { consensus.ffProposals.proposals[c.block.hash] = c })
            if (!consensus.ffProposals.respondentTs) consensus.ffProposals.respondentTs = {}
            consensus.ffProposals.respondents[ownName] = candidates[0].block.hash
            consensus.ffProposals.respondentTs[ownName] = now
            p2p.broadcast(consensus.signMessage({
                t: 7,
                d: { height: height, hashes: candidates.map(c => c.block.hash), timestamp: candidates[0].block.timestamp }
            }))
        }

        // Count only RECENT votes: a node that goes down stops refreshing its
        // timestamp and drops out after `freshWindow`, so it no longer blocks
        // unanimity. Stale votes from dead nodes were the other half of the bug.
        const proposal = consensus.ffProposals && consensus.ffProposals.height === height
            ? consensus.ffProposals
            : null
        const allRespondents = (proposal && proposal.respondents) || {}
        const tsMap = (proposal && proposal.respondentTs) || {}
        const freshWindow = 2 * (config.haltBreakerMs || 21000)
        const respondents = {}
        for (const name of Object.keys(allRespondents))
            // a vote with no timestamp is treated as fresh (can't age it out)
            if (!tsMap[name] || now - tsMap[name] <= freshWindow) respondents[name] = allRespondents[name]

        const respondentNames = Object.keys(respondents)
        const quorum = consensusQuorum.blockQuorum(eligible.length, config.quorumMin)
        const missing = eligible.filter(n => respondentNames.indexOf(n) === -1)
        const enough = respondentNames.length >= 3 && respondentNames.length > eligible.length - quorum
        if (!enough) {
            logr.warn('Halt breaker cannot fire for height ' + height + ': only '
                + respondentNames.length + '/' + eligible.length + ' respondents'
                + (missing.length ? ' (missing ' + missing.join(',') + ')' : '')
                + ', need >= 3 and > E-q (' + (eligible.length - quorum) + ')')
            // Re-arm: the missing nodes may still show up.
            if (height === chain.getLatestBlock()._id + 1) {
                const retry = setTimeout(() => consensus.runHaltBreaker(height), 5000)
                if (retry.unref) retry.unref()
            }
            return
        }

        const hashVotes = {}
        for (const hash of Object.values(respondents))
            hashVotes[hash] = (hashVotes[hash] || 0) + 1
        const bestHash = Object.keys(hashVotes).reduce((a, b) => hashVotes[a] > hashVotes[b] ? a : b)
        if (hashVotes[bestHash] !== respondentNames.length) {
            logr.warn('Halt breaker cannot fire for height ' + height + ': split vote', hashVotes)
            if (height === chain.getLatestBlock()._id + 1) {
                const retry = setTimeout(() => consensus.runHaltBreaker(height), 5000)
                if (retry.unref) retry.unref()
            }
            return
        }

        const winner = candidates.find(c => c.block.hash === bestHash) || candidates[0]
        logr.warn('Halt breaker firing for height ' + height + '#' + winner.block.hash.substr(0, 8)
            + ' with unanimity ' + respondentNames.length + '/' + respondentNames.length
            + ' of the remaining leaders (eligible ' + eligible.length + '='
            + respondentNames.join(',') + (missing.length ? ' missing ' + missing.join(',') : '') + ')')
        consensus._applyForceFinalize(height, winner, 0)
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

        consensus.scheduleHaltBreaker()
    },
    _getQuorumThreshold: () => {
        const activeCount = Math.max(1, consensus.eligibleLeaders(chain.getLatestBlock()._id + 1).length)
        // Force-finalize uses the SAME quorum as block consensus — it is a
        // liveness backstop, not a cheaper consensus. Two things were wrong
        // with the previous formula
        //   min(ceil(config.leaders*2/3), max(ceil(activeCount*2/3), 3)):
        //  * the `max(..., 3)` was unreachable on a 1- or 2-node network, so
        //    force-finalize could never fire there (it needs 3 votes from 1 node);
        //  * `min(config.leaders*2/3, ...)` capped it by the CONFIGURED leader
        //    count, while activeLeaders() can return up to 2*config.leaders
        //    names: at n=6 it gave 4 (=exactly 2n/3, unsafe) where block
        //    consensus already required 5.
        const threshold = consensusQuorum.blockQuorum(activeCount, config.quorumMin)

        // S0' shadow: only observe. The legacy formula is kept in
        // consensusQuorum.legacyForceFinalizeQuorum() so this can report the
        // tightening it would have hidden.
        consensus.qcGuard('ff-threshold', () => {
            const legacy = consensusQuorum.legacyForceFinalizeQuorum(activeCount, config.leaders)
            const expectedHeight = chain.getLatestBlock()._id + 1
            if (legacy !== threshold && consensus.qc.ffThresholdLoggedHeight !== expectedHeight) {
                consensus.qc.ffThresholdLoggedHeight = expectedHeight
                consensus.qc.thresholdMismatches++
                logr.warn('QC-FF-THRESHOLD-DIVERGENCE at height '+expectedHeight
                    +': unified '+threshold+' vs legacy '+legacy+' (n='+activeCount+')'
                    +(threshold > legacy ? ' — legacy force-finalize quorum was LOWER' : ''))
            }
        })

        return threshold
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

        candidates.sort((a, b) => chain.compareBlockRank(chain.deriveBlockRank(a.block), chain.deriveBlockRank(b.block)))

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
        consensus.ffProposals = { height, proposals: {}, respondents: {}, respondentTs: {} }
        candidates.forEach(c => { consensus.ffProposals.proposals[c.block.hash] = c })
        if (consensus.getActiveLeaderKey(ownName)) {
            let ownHash = winner.block.hash
            // Monotone (doc §5.5.3): never move our own FF vote to a worse rank.
            // Compare against the rank recorded when we voted, so this still works
            // if the previously voted block has left the local candidate set.
            const prev = consensus.ffVote && consensus.ffVote.height === height ? consensus.ffVote : null
            if (prev && prev.hash !== ownHash
            && chain.compareBlockRank(chain.deriveBlockRank(winner.block), prev.rank) >= 0)
                ownHash = prev.hash
            consensus.ffProposals.respondents[ownName] = ownHash
            consensus.ffProposals.respondentTs[ownName] = Date.now()
            if (ownHash === winner.block.hash)
                consensus.ffVote = { height: height, hash: ownHash, rank: chain.deriveBlockRank(winner.block) }
        }

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
        allCandidates.sort((a, b) => chain.compareBlockRank(chain.deriveBlockRank(a.block), chain.deriveBlockRank(b.block)))

        // Monotone improvement (doc §5.5.3): if a better-ranked candidate has
        // arrived since we voted, move our own vote to it; never away.
        const ownName = process.env.NODE_OWNER
        if (consensus.getActiveLeaderKey(ownName)) {
            const best = allCandidates[0].block
            const own = consensus.ffProposals.respondents[ownName]
            const ownRank = consensus.ffVote && consensus.ffVote.height === height ? consensus.ffVote.rank : null
            if (own && own !== best.hash && ownRank
            && chain.compareBlockRank(chain.deriveBlockRank(best), ownRank) < 0) {
                consensus.ffProposals.respondents[ownName] = best.hash
                consensus.ffVote = { height: height, hash: best.hash, rank: chain.deriveBlockRank(best) }
                logr.cons('FF monotone: own vote moved to better candidate ' + height + '#' + best.hash.substr(0, 8))
            }
        }

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
            const prevTs = {}
            if (consensus.ffProposals && consensus.ffProposals.respondents)
                Object.assign(prevRespondents, consensus.ffProposals.respondents)
            if (consensus.ffProposals && consensus.ffProposals.respondentTs)
                Object.assign(prevTs, consensus.ffProposals.respondentTs)
            consensus.ffProposals.respondents = prevRespondents
            consensus.ffProposals.respondentTs = prevTs

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
            // Layer S halt breaker: before falling back to a unilateral decision,
            // give the remaining eligible leaders a chance to reach unanimity.
            // Keep ffProposals: runHaltBreaker() reads its `respondents` to decide
            // whether the surviving leaders agree. Nulling it here (as it was)
            // made the breaker see 0/5 respondents and never fire.
            if (config.haltBreaker) {
                logr.warn('FF backoff exhausted for height ' + height + '; trying halt breaker')
                consensus.finalizing = false
                consensus.runHaltBreaker(height)
                return
            }

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
        // S0' shadow: force-finalize must not contradict our own precommit.
        // In S1' this becomes a hard refusal (doc §2.6).
        consensus.qcGuard('ff-conflict', () => {
            if (consensusQuorum.canPrecommit(consensus.qc.ledger, height, winner.block.hash)) return
            consensus.qc.ffConflicts++
            logr.error('QC-FF-CONFLICT force finalize would apply '+height+'#'
                +winner.block.hash.substr(0, 8)+' but this node precommitted '
                +String(consensusQuorum.lockedOn(consensus.qc.ledger, height)).substr(0, 8)
                +' (shadow: applying anyway)')
        })
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