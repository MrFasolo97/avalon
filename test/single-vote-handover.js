// == Single-vote default + round handover (M1/M2) ==
// node test/single-vote-handover.js
//
// M1: a higher-round (backup) candidate is the legitimate successor of a silent
// lower-round proposer. It must not be rejected by isBestCandidate's timestamp
// ranking, which always favours the earlier/stale candidate and split the
// precommit quorum.
// M2: COMMIT must follow the node's own PRECOMMIT lock, and among candidates with
// a precommit QC the HIGHEST round wins (a newer view supersedes an older one).

const assert = require('assert')
const consensusQuorum = require('../src/consensusQuorum')

const PRE = consensusQuorum.PRECOMMIT
const COM = consensusQuorum.COMMIT
const ladder = ['l1', 'l2', 'l3', 'l4', 'l5']
const h = 101

if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        leaders: 5,
        consensusRounds: 2,
        consensusSigVersion: 2,
        blockTime: 3000,
        quorumMin: 3,
        singleVote: true,
        qcEnforce: false,
        forceFinalize: false,
        forceFinalizeFallback: false,
        read: () => global.config
    }
if (typeof global.chain === 'undefined')
    global.chain = {
        getLatestBlock: () => ({ _id: h - 1, hash: 'head' }),
        roundFor: (height, name) => {
            const p = ladder.indexOf(name)
            return p >= 0 ? p : 999
        },
        deriveBlockRank: (block) => ({
            timestamp: block.timestamp,
            ladderPos: ladder.indexOf(block.miner) >= 0 ? ladder.indexOf(block.miner) : 999,
            hash: block.hash || ''
        }),
        compareBlockRank: (a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
            if (a.ladderPos !== b.ladderPos) return a.ladderPos - b.ladderPos
            return String(a.hash).localeCompare(String(b.hash))
        },
        validateAndAddBlock: () => {}
    }
if (typeof global.logr === 'undefined')
    global.logr = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, cons: () => {}, fatal: () => {}, econ: () => {} }
if (typeof global.p2p === 'undefined')
    global.p2p = { broadcast: () => {}, recordBlockFailure: () => {} }

process.env.NODE_OWNER = 'me'

const consensus = require('../src/consensus')
consensus.eligibleLeaders = () => ladder.slice()

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        failed++
    }
}

function reset() {
    consensus.voteLedger = consensusQuorum.createLedger({ singleVote: true })
    consensus.possBlocks = []
    consensus.heightSeen = {}
    consensus.commitRetry = {}
}

function pb(hash, miner, timestamp, preVotes) {
    return {
        block: { _id: h, hash, miner, timestamp },
        0: preVotes || [],
        1: []
    }
}

console.log('=== Single-vote default / round handover (M1, M2) ===\n')

test('singleVote is enabled by default in the shipped chain config', () => {
    const realConfig = require('../src/config')
    assert.strictEqual(realConfig.history[0].singleVote, true)
    assert.strictEqual(realConfig.history[13325000].singleVote, undefined,
        'the S/H fork must not override the default')
    assert.strictEqual(realConfig.history[0].forceFinalizeFallback, false,
        'FF fallback must stay off: no halt recovery by bypassing quorum')
    assert.strictEqual(consensus.singleVoteEnabled, true)
})

test('M1: a higher-round backup is precommitted during leader handover', () => {
    reset()
    const leader = pb('z-leader', 'l1', 1000)
    const backup = pb('a-backup', 'l2', 2000)
    consensus.possBlocks = [leader, backup]
    assert.strictEqual(consensus.lowestCandidateRound(h), 0)
    assert.strictEqual(consensus.castVote(PRE, backup.block), true,
        'the backup must not be rejected for ranking worse than the stale leader')
    assert.strictEqual(consensusQuorum.lockedOn(consensus.voteLedger, h), 'a-backup')
})

test('M1: two candidates in the SAME round still pick one deterministically', () => {
    reset()
    const worse = pb('z-same', 'l1', 2000)
    const better = pb('a-same', 'l1', 1000)
    consensus.possBlocks = [worse, better]
    assert.strictEqual(consensus.lowestCandidateRound(h), 0)
    assert.strictEqual(consensus.castVote(PRE, worse.block), false)
    assert.strictEqual(consensus.castVote(PRE, better.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.voteLedger, h), 'a-same')
})

test('M2: COMMIT follows our own precommit lock', () => {
    reset()
    const ours = pb('A', 'l1', 1000)
    const other = pb('B', 'l2', 2000, ['l1', 'l2', 'l3', 'l4'])
    consensus.possBlocks = [ours, other]
    assert.strictEqual(consensus.castVote(PRE, ours.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.voteLedger, h), 'A')
    consensus.heightSeen[h] = Date.now() - 60000 // window settled
    assert.strictEqual(consensus.castVote(COM, other.block), false,
        'must not commit a hash we never precommitted')
    assert.deepStrictEqual(
        Array.from(consensusQuorum.signersForHash(consensus.voteLedger, h, COM, 'B', 0)), [])
})

test('M2: the highest round with a precommit QC wins the COMMIT', () => {
    reset()
    const old = pb('old-leader', 'l1', 1000, ['l1', 'l2', 'l3', 'l4'])
    const handover = pb('new-backup', 'l2', 2000, ['l1', 'l2', 'l3', 'l4'])
    consensus.possBlocks = [old, handover]
    const best = consensus.bestCommittableCandidate(h, 4)
    assert.ok(best)
    assert.strictEqual(best.hash, 'new-backup',
        'a later view supersedes the silent earlier proposer')
})

test('M2: once locked, a node commits its own candidate when it is the best one', () => {
    reset()
    const a = pb('A', 'l2', 1000, ['l1', 'l2', 'l3', 'l4'])
    consensus.possBlocks = [a]
    assert.strictEqual(consensus.castVote(PRE, a.block), true)
    assert.strictEqual(consensus.castVote(COM, a.block), true)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
