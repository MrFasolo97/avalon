// == Observer / backup finalize gate (doc §2.5) ==
// node test/observer-finalize.js
//
// The S0'/S refactor removed the local "push ourselves into round 0" that the
// old code did for every node, and moved it into endRound() guarded by
// isActive(). tryNextStep() still required the node's own name in round 0, so a
// non-leader (observer) node could never finalise a block. These assertions pin
// the fix: an observer finalises on the QC alone, an elected leader still has to
// have precommitted.

const assert = require('assert')

if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        leaders: 5,
        consensusRounds: 2,
        consensusSigVersion: 2,
        blockTime: 3000,
        maxDrift: 200,
        forceFinalize: false,
        forceFinalizeFallback: false,
        quorumEligibility: 'activeLeaders',
        read: () => global.config
    }

let applied = null

if (typeof global.chain === 'undefined')
    global.chain = {
        schedule: { shuffle: ['l1', 'l2', 'l3', 'l4', 'l5'].map(n => ({ name: n, pub_leader: 'pub-' + n })) },
        recentBlocks: [],
        getLatestBlock: () => ({ _id: 0, hash: 'genesis' }),
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

// deterministic eligible set: n = 5 => threshold = blockQuorum(5) = 4
consensus.eligibleLeaders = () => ['l1', 'l2', 'l3', 'l4', 'l5']

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
    consensus.finalizing = false
    consensus.tryNextStepBusy = false
    applied = null
}

function possBlock(hash, round0, round1) {
    return { block: { _id: 1, hash: hash, miner: 'other', timestamp: 1000 }, 0: round0, 1: round1 }
}

console.log('=== Observer / backup finalize gate ===\n')

test('an observer finalises on the QC alone (no self-vote)', () => {
    reset()
    consensus.isActive = () => false
    consensus.possBlocks = [possBlock('h-obs', [], ['l1', 'l2', 'l3', 'l4'])]
    consensus.tryNextStep()
    assert.ok(applied, 'observer must finalise when the QC is reached')
    assert.strictEqual(applied.hash, 'h-obs')
})

test('an observer does not finalise below quorum', () => {
    reset()
    consensus.isActive = () => false
    consensus.possBlocks = [possBlock('h-obs-low', [], ['l1', 'l2', 'l3'])]
    consensus.tryNextStep()
    assert.strictEqual(applied, null)
})

test('an elected leader without its own precommit does NOT finalise', () => {
    reset()
    consensus.isActive = () => true
    consensus.possBlocks = [possBlock('h-leader-noPre', [], ['l1', 'l2', 'l3', 'l4'])]
    consensus.tryNextStep()
    assert.strictEqual(applied, null, 'a leader must have precommitted before finalising')
})

test('an elected leader that precommitted finalises', () => {
    reset()
    consensus.isActive = () => true
    consensus.possBlocks = [possBlock('h-leader', ['me', 'l1', 'l2', 'l3'], ['l1', 'l2', 'l3', 'l4'])]
    consensus.tryNextStep()
    assert.ok(applied, 'a precommitted leader must finalise when the QC is reached')
    assert.strictEqual(applied.hash, 'h-leader')
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
