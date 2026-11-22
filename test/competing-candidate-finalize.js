// == Competing candidates at the same height (singleVote OFF) ==
// node test/competing-candidate-finalize.js
//
// With singleVote:false every node votes on EVERY candidate at a height, so the
// block that first reaches the local quorum is arrival-order dependent. Without
// arbitration two nodes can finalise two different blocks at the same height.
// tryNextStep() must wait for the round window to settle and then apply only the
// deterministic best-ranked candidate (chain.deriveBlockRank via
// consensus.isBestCandidate).

const assert = require('assert')

const SETTLE_MS = (5 + 1) * 3000 // (leaders + 1) * blockTime

if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        leaders: 5,
        consensusRounds: 2,
        consensusSigVersion: 2,
        blockTime: 3000,
        quorumMin: 3,
        forceFinalize: false,
        forceFinalizeFallback: false,
        singleVote: false,
        qcEnforce: false,
        read: () => global.config
    }

const ladder = ['l1', 'l2', 'l3', 'l4', 'l5']
const headHeight = 100
let applied = null

if (typeof global.chain === 'undefined')
    global.chain = {
        schedule: { shuffle: ladder.map(n => ({ name: n, pub_leader: 'pub-' + n })) },
        recentBlocks: [],
        getLatestBlock: () => ({ _id: headHeight, hash: 'genesis' }),
        leaderLadder: () => ladder.slice(),
        deriveBlockRank: (block) => {
            const pos = ladder.indexOf(block.miner)
            return {
                timestamp: block.timestamp,
                ladderPos: pos >= 0 ? pos : 999,
                hash: block.hash || ''
            }
        },
        compareBlockRank: (a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
            if (a.ladderPos !== b.ladderPos) return a.ladderPos - b.ladderPos
            return String(a.hash).localeCompare(String(b.hash))
        },
        validateAndAddBlock: (b, revalidate, cb) => { applied = b; cb(null) }
    }
if (typeof global.p2p === 'undefined')
    global.p2p = { broadcast: () => {}, recordBlockFailure: () => {} }
if (typeof global.logr === 'undefined')
    global.logr = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, cons: () => {}, fatal: () => {}, econ: () => {} }
if (typeof global.cache === 'undefined')
    global.cache = { rollback: () => {} }
if (typeof global.dao === 'undefined')
    global.dao = { resetID: () => {} }
if (typeof global.daoMaster === 'undefined')
    global.daoMaster = { resetID: () => {} }

process.env.NODE_OWNER = 'me'

const consensus = require('../src/consensus')

// n = 5 => threshold = blockQuorum(5) = 4
consensus.eligibleLeaders = () => ladder.slice()
consensus.isActive = () => false // observer: QC alone is enough

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
    for (const k of Object.keys(consensus.commitRetry)) clearTimeout(consensus.commitRetry[k])
    consensus.possBlocks = []
    consensus.heightSeen = {}
    consensus.commitRetry = {}
    consensus.finalizing = false
    consensus.tryNextStepBusy = false
    consensus.tryNextStepScheduled = false
    applied = null
}

function possBlock(hash, miner, timestamp, round0, round1) {
    return {
        block: { _id: headHeight + 1, hash: hash, miner: miner, timestamp: timestamp },
        0: round0 || [],
        1: round1 || ['l1', 'l2', 'l3', 'l4']
    }
}

// Best by chain rank: A is the scheduled leader (ladderPos 0) but has the
// HIGHER hash, so the old timestamp/hash sort puts B first locally.
function contenders() {
    const a = possBlock('z-leader', 'l1', 1000)
    const b = possBlock('a-backup', 'l2', 1000)
    return { a, b }
}

console.log('=== Competing candidate finalization (singleVote OFF) ===\n')

test('a colliding candidate crossing the local quorum first is NOT finalized', () => {
    reset()
    const { a, b } = contenders()
    consensus.possBlocks = [b, a]
    consensus.heightSeen[headHeight + 1] = Date.now()
    consensus.tryNextStep()
    assert.strictEqual(applied, null, 'must wait for the settle window')
    assert.ok(consensus.commitRetry[headHeight + 1], 'a retry must actually re-run the step')
})

test('after the window only the best-ranked candidate is finalized', () => {
    reset()
    const { a, b } = contenders()
    consensus.possBlocks = [b, a] // local sort also puts b first
    consensus.heightSeen[headHeight + 1] = Date.now() - SETTLE_MS - 100
    consensus.tryNextStep()
    assert.ok(applied, 'a quorum candidate must be finalized after the window')
    assert.strictEqual(applied.hash, 'z-leader')
})

test('the winner is independent of the local arrival order', () => {
    reset()
    const { a, b } = contenders()
    consensus.possBlocks = [a, b] // reversed
    consensus.heightSeen[headHeight + 1] = Date.now() - SETTLE_MS - 100
    consensus.tryNextStep()
    assert.ok(applied)
    assert.strictEqual(applied.hash, 'z-leader')
})

test('a single candidate still finalizes immediately (no regression)', () => {
    reset()
    const { a } = contenders()
    consensus.possBlocks = [a]
    consensus.heightSeen[headHeight + 1] = Date.now()
    consensus.tryNextStep()
    assert.ok(applied)
    assert.strictEqual(applied.hash, 'z-leader')
})

test('the deferred retry finalizes the best candidate once the window elapsed', () => {
    reset()
    const { a, b } = contenders()
    consensus.possBlocks = [b, a]
    consensus.heightSeen[headHeight + 1] = Date.now()
    const realSetTimeout = global.setTimeout
    const captured = []
    global.setTimeout = (fn, ms) => { captured.push({ fn, ms }); return { unref() {} } }
    try {
        consensus.tryNextStep()
        const retry = captured.find(c => c.ms > 100)
        assert.ok(retry, 'a settle-window retry must be scheduled')
        consensus.heightSeen[headHeight + 1] = Date.now() - SETTLE_MS - 100
        retry.fn()
        assert.ok(applied, 'retry must finalize')
        assert.strictEqual(applied.hash, 'z-leader')
    } finally {
        global.setTimeout = realSetTimeout
    }
})

test('the active-leader self-precommit gate still applies under collision', () => {
    reset()
    consensus.isActive = () => true
    const { a, b } = contenders()
    a[0] = ['l1', 'l2', 'l3'] // best candidate: no vote from us
    b[0] = ['me', 'l1', 'l2']
    consensus.possBlocks = [b, a]
    consensus.heightSeen[headHeight + 1] = Date.now() - SETTLE_MS - 100
    consensus.tryNextStep()
    assert.strictEqual(applied, null, 'leader must not finalize a block it did not precommit')
    consensus.isActive = () => false
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
