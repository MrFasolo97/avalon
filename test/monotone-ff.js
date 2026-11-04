// == Monotone force-finalize votes (doc §5.5.3) ==
// node test/monotone-ff.js
//
// A node may change its force-finalize vote only towards a strictly better
// (lower) chain rank, never away. This is enforced both for our own vote and
// for the votes we accept from peers, and it is what stops two nodes from
// ping-ponging on their own local winner.

const assert = require('assert')

if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        leaders: 5,
        consensusRounds: 2,
        consensusSigVersion: 2,
        blockTime: 3000,
        maxDrift: 200,
        forceFinalize: true,
        forceFinalizeFallback: false,
        quorumEligibility: 'activeLeaders',
        read: () => global.config
    }

if (typeof global.chain === 'undefined')
    global.chain = {
        schedule: { shuffle: [] },
        recentBlocks: [],
        getLatestBlock: () => ({ _id: 0, hash: 'genesis' }),
        // rank is carried directly on the test block: lower = better
        deriveBlockRank: (b) => ({ timestamp: b.rank, ladderPos: 0, hash: b.hash }),
        compareBlockRank: (a, b) => a.timestamp - b.timestamp
    }
if (typeof global.p2p === 'undefined')
    // no `broadcast`: _forceFinalize skips the signing/broadcast path (which would
    // need a real private key), and only the vote bookkeeping is under test
    global.p2p = { broadcastNotSent: () => {}, recordBlockFailure: () => {} }
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

consensus.getActiveLeaderKey = () => 'pub'
consensus.activeLeaders = () => ['l1', 'me']
consensus._resolveForceFinalize = () => {}

function block(hash, rank) {
    return { block: { _id: 1, hash: hash, rank: rank, miner: 'm-' + hash, timestamp: rank * 100 }, 0: [], 1: [] }
}

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
    consensus.ffProposals = null
    consensus.ffVote = null
    consensus.ffMonotoneRejects = 0
    consensus.possBlocks = [block('A', 2), block('B', 1)]
    consensus.finalizing = false
}

console.log('=== Monotone force-finalize votes ===\n')

console.log('--- the rank helper ---')

test('a lower rank is strictly better', () => {
    reset()
    consensus.ffProposals = { height: 1, proposals: { A: block('A', 2), B: block('B', 1) }, respondents: {} }
    assert.strictEqual(consensus.ffBetter(1, 'B', 'A'), true)
    assert.strictEqual(consensus.ffBetter(1, 'A', 'B'), false)
    assert.strictEqual(consensus.ffBetter(1, 'A', 'A'), false)
})

console.log('\n--- a peer may only improve its vote ---')

test('a peer vote is accepted, then improved, then a downgrade is refused', () => {
    reset()
    consensus.ffProposals = {
        height: 1,
        proposals: { A: block('A', 2), B: block('B', 1) },
        respondents: {}
    }
    const msg = (hash) => ({ s: { n: 'l1' }, d: { height: 1, hash: hash } })

    consensus.handleForceFinalizeProposal(msg('A'))
    assert.strictEqual(consensus.ffProposals.respondents.l1, 'A')

    consensus.handleForceFinalizeProposal(msg('B')) // better
    assert.strictEqual(consensus.ffProposals.respondents.l1, 'B')

    consensus.handleForceFinalizeProposal(msg('A')) // worse -> ignored
    assert.strictEqual(consensus.ffProposals.respondents.l1, 'B')
    assert.strictEqual(consensus.ffMonotoneRejects, 1)
})

console.log('\n--- our own vote may only improve ---')

test('our own FF vote never moves to a worse candidate', () => {
    reset()
    // first round: the local best is B
    consensus._forceFinalize(1)
    assert.strictEqual(consensus.ffProposals.respondents.me, 'B')
    assert.strictEqual(consensus.ffVote.hash, 'B')

    // later a worse-only candidate set arrives: our vote must stay on B
    consensus.ffProposals = null
    consensus.finalizing = false
    consensus.possBlocks = [block('A', 2)]
    consensus._forceFinalize(1)
    assert.strictEqual(consensus.ffProposals.respondents.me, 'B')
})

test('our own FF vote does move to a strictly better candidate', () => {
    reset()
    consensus.possBlocks = [block('A', 2)]
    consensus._forceFinalize(1)
    assert.strictEqual(consensus.ffProposals.respondents.me, 'A')

    consensus.ffProposals = null
    consensus.finalizing = false
    consensus.possBlocks = [block('C', 0)]
    consensus._forceFinalize(1)
    assert.strictEqual(consensus.ffProposals.respondents.me, 'C')
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
