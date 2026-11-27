// == Halt breaker recovery (Layer S/H) ==
// node test/halt-breaker.js

const assert = require('assert')

// Stub globals used by consensus.js
if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        haltBreaker: true,
        haltBreakerMs: 21000,
        blockTime: 3000
    }
if (typeof global.chain === 'undefined')
    global.chain = {
        getLatestBlock: () => ({ _id: 0, hash: 'genesis' }),
        schedule: { shuffle: [] },
        recentBlocks: [],
        leaderLadder: () => ['alice', 'bob', 'carol'],
        deriveBlockRank: (b) => ({ timestamp: b.timestamp, ladderPos: 0, hash: b.hash }),
        compareBlockRank: (a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
            if (a.ladderPos !== b.ladderPos) return a.ladderPos - b.ladderPos
            return String(a.hash).localeCompare(String(b.hash))
        }
    }
if (typeof global.logr === 'undefined')
    global.logr = { debug: () => {}, cons: () => {}, warn: () => {}, error: () => {}, info: () => {}, fatal: () => {} }
if (typeof global.p2p === 'undefined')
    global.p2p = { broadcast: () => {}, broadcastNotSent: () => {} }
if (typeof global.leaderHealth === 'undefined')
    global.leaderHealth = { snapshot: () => ({}) }

const consensus = require('../src/consensus')

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
    consensus.possBlocks = []
    consensus.ffProposals = null
    consensus.finalizing = false
    if (consensus.haltBreakerTimeout) {
        clearTimeout(consensus.haltBreakerTimeout)
        consensus.haltBreakerTimeout = null
    }
    if (consensus.forceFinalizeTimeout) {
        clearTimeout(consensus.forceFinalizeTimeout)
        consensus.forceFinalizeTimeout = null
    }
}

// Override eligibleLeaders and activeLeaders for deterministic tests
let testEligible = []
consensus.activeLeaders = () => testEligible
consensus.eligibleLeaders = () => testEligible

let applied = null
// Keep the real implementation: one regression test below needs to verify
// that applying a winner re-arms the backstop for already-queued candidates.
const realApplyForceFinalize = consensus._applyForceFinalize
consensus._applyForceFinalize = (height, winner) => {
    applied = { height, winner }
}

console.log('=== Halt breaker ===\n')

test('scheduleHaltBreaker arms when a candidate exists', () => {
    reset()
    consensus.possBlocks = [{ block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } }]
    consensus.scheduleHaltBreaker()
    assert.ok(consensus.haltBreakerTimeout)
    clearTimeout(consensus.haltBreakerTimeout)
    consensus.haltBreakerTimeout = null
})

test('scheduleHaltBreaker does nothing when disabled', () => {
    reset()
    const saved = config.haltBreaker
    config.haltBreaker = false
    consensus.possBlocks = [{ block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } }]
    consensus.scheduleHaltBreaker()
    assert.strictEqual(consensus.haltBreakerTimeout, null)
    config.haltBreaker = saved
})

test('runHaltBreaker finalizes when all eligible leaders agree unanimously', () => {
    reset()
    testEligible = ['alice', 'bob', 'carol']
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } },
        { block: { _id: 1, hash: 'b', miner: 'bob', timestamp: 2000 } }
    ]
    consensus.ffProposals = {
        height: 1,
        proposals: {},
        respondents: { alice: 'a', bob: 'a', carol: 'a' }
    }
    applied = null
    consensus.runHaltBreaker(1)
    assert.ok(applied)
    assert.strictEqual(applied.height, 1)
    assert.strictEqual(applied.winner.block.hash, 'a')
})

test('runHaltBreaker does nothing when votes are split', () => {
    reset()
    testEligible = ['alice', 'bob', 'carol']
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } },
        { block: { _id: 1, hash: 'b', miner: 'bob', timestamp: 2000 } }
    ]
    consensus.ffProposals = {
        height: 1,
        proposals: {},
        respondents: { alice: 'a', bob: 'b', carol: 'a' }
    }
    applied = null
    consensus.runHaltBreaker(1)
    assert.strictEqual(applied, null)
})

test('runHaltBreaker does nothing when some eligible leaders are missing', () => {
    reset()
    testEligible = ['alice', 'bob', 'carol']
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } }
    ]
    consensus.ffProposals = {
        height: 1,
        proposals: {},
        respondents: { alice: 'a', bob: 'a' }
    }
    applied = null
    consensus.runHaltBreaker(1)
    assert.strictEqual(applied, null)
})

test('runHaltBreaker ignores stale votes from nodes that went down', () => {
    reset()
    testEligible = ['alice', 'bob', 'carol']
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } }
    ]
    // alice votes, then goes down; bob and carol are alive and agree
    const stale = Date.now() - 300000
    consensus.ffProposals = {
        height: 1,
        proposals: {},
        respondents: { alice: 'a', bob: 'a', carol: 'a' },
        respondentTs: { alice: stale, bob: Date.now(), carol: Date.now() }
    }
    applied = null
    consensus.runHaltBreaker(1)
    assert.strictEqual(applied, null, 'a stale (dead-node) vote must not block unanimity')

    // once alice's stale vote ages out, the two live nodes are still < floor(3):
    // nothing fires — the floor requires the whole remaining set
    assert.strictEqual(consensus.ffMonotoneRejects, 0)
})

test('runHaltBreaker fires on the fresh unanimous set after the dead age out', () => {
    reset()
    testEligible = ['alice', 'bob', 'carol']
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } }
    ]
    const stale = Date.now() - 300000
    const now = Date.now()
    // dead node stale; three live nodes unanimous
    consensus.ffProposals = {
        height: 1,
        proposals: {},
        respondents: { dead: 'a', bob: 'a', carol: 'a', dave: 'a' },
        respondentTs: { dead: stale, bob: now, carol: now, dave: now }
    }
    testEligible = ['dead', 'bob', 'carol', 'dave']
    applied = null
    consensus.runHaltBreaker(1)
    assert.ok(applied, 'fresh unanimity of the remaining three should fire')
    assert.strictEqual(applied.winner.block.hash, 'a')
})

test('HALT_BREAKER=0 disables the breaker even when chain config enables it', () => {
    reset()
    const savedEnv = process.env.HALT_BREAKER
    try {
        process.env.HALT_BREAKER = '0'
        config.haltBreaker = true
        consensus.possBlocks = [{ block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } }]
        applied = null
        consensus.scheduleHaltBreaker()
        assert.strictEqual(consensus.haltBreakerTimeout, null, 'the off-switch must not arm the breaker')
        consensus.runHaltBreaker(1)
        assert.strictEqual(applied, null, 'the off-switch must not finalize via the breaker')
    } finally {
        if (savedEnv === undefined) delete process.env.HALT_BREAKER
        else process.env.HALT_BREAKER = savedEnv
        config.haltBreaker = true
    }
})

test('FF majority fallback applies signed votes when HALT_BREAKER=0', () => {
    reset()
    const savedEnv = process.env.HALT_BREAKER
    const savedQuorumMin = config.quorumMin
    const savedFallback = config.forceFinalizeFallback
    const savedThreshold = consensus._getQuorumThreshold
    const savedRun = consensus.runHaltBreaker
    try {
        process.env.HALT_BREAKER = '0'
        config.haltBreaker = true
        config.quorumMin = 3
        config.forceFinalizeFallback = false
        consensus._getQuorumThreshold = () => 4
        consensus.runHaltBreaker = () => { throw new Error('halt breaker must stay off') }
        const eligible = ['alice', 'bob', 'carol', 'dave', 'erin']
        consensus.activeLeaders = () => eligible
        consensus.eligibleLeaders = () => eligible

        const blockA = { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 }
        const blockB = { _id: 1, hash: 'b', miner: 'bob', timestamp: 2000 }
        consensus.possBlocks = [{ block: blockA }, { block: blockB }]
        consensus.ffProposals = {
            height: 1,
            proposals: { a: { block: blockA }, b: { block: blockB } },
            // 3/5 signed votes: an absolute majority but below the 4-vote quorum.
            respondents: { alice: 'a', bob: 'a', carol: 'a', dave: 'b', erin: 'b' }
        }

        applied = null
        // 7 is the last breaker-off FF attempt (4 base + 4 extra, zero-based).
        consensus._resolveForceFinalize(1, 0, 7)
        assert.ok(applied, 'the majority must be applied instead of halting')
        assert.strictEqual(applied.winner.block.hash, 'a')
    } finally {
        if (savedEnv === undefined) delete process.env.HALT_BREAKER
        else process.env.HALT_BREAKER = savedEnv
        config.quorumMin = savedQuorumMin
        config.forceFinalizeFallback = savedFallback
        consensus._getQuorumThreshold = savedThreshold
        consensus.runHaltBreaker = savedRun
        consensus.activeLeaders = () => testEligible
        consensus.eligibleLeaders = () => testEligible
        config.haltBreaker = true
    }
})

test('force finalize re-arms the backstop for already-queued next-height candidates', () => {
    reset()
    const savedApply = consensus._applyForceFinalize
    const savedSchedule = consensus.scheduleForceFinalize
    const savedValidate = chain.validateAndAddBlock
    const savedForceFinalize = config.forceFinalize
    let scheduled = 0
    try {
        config.forceFinalize = true
        consensus.scheduleForceFinalize = () => { scheduled++ }
        chain.validateAndAddBlock = (block, revalidate, cb) => cb(null)
        consensus._applyForceFinalize = realApplyForceFinalize

        consensus.possBlocks = [{ block: { _id: 2, hash: 'next', miner: 'alice', timestamp: 2000 } }]
        consensus._applyForceFinalize(
            1,
            { block: { _id: 1, hash: 'a', miner: 'alice', timestamp: 1000 } },
            0
        )
        assert.strictEqual(scheduled, 1, 'a queued next-height candidate must re-arm force-finalize')
    } finally {
        consensus._applyForceFinalize = savedApply
        consensus.scheduleForceFinalize = savedSchedule
        chain.validateAndAddBlock = savedValidate
        config.forceFinalize = savedForceFinalize
    }
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
