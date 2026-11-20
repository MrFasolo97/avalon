// == Stale possBlock pruning (liveness after catch-up / equivocation) ==
// node test/poss-block-prune.js

const assert = require('assert')

// Stub globals used by consensus.js
if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        blockTime: 3000,
        consensusRounds: 2,
        forceFinalize: true
    }
if (typeof global.logr === 'undefined')
    global.logr = { debug: () => {}, cons: () => {}, warn: () => {}, error: () => {}, info: () => {}, fatal: () => {} }

let headHeight = 100
if (typeof global.chain === 'undefined')
    global.chain = { getLatestBlock: () => ({ _id: headHeight, hash: 'head' }) }
else
    headHeight = global.chain.getLatestBlock()._id

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
    consensus.heightSeen = {}
    consensus.commitRetry = {}
}

const pb = (h, hash) => ({ block: { _id: h, hash, miner: 'm' } })

test('drops candidates at and below the canonical head', () => {
    reset()
    const h = global.chain.getLatestBlock()._id
    consensus.possBlocks = [pb(h - 3, 'old1'), pb(h - 1, 'old2'), pb(h, 'same'), pb(h + 1, 'next')]
    consensus.pruneStaleCandidates()
    assert.deepStrictEqual(consensus.possBlocks.map(x => x.block.hash), ['next'])
})

test('keeps all candidates when head has not advanced', () => {
    reset()
    const h = global.chain.getLatestBlock()._id
    consensus.possBlocks = [pb(h + 1, 'a'), pb(h + 1, 'b')]
    consensus.pruneStaleCandidates()
    assert.strictEqual(consensus.possBlocks.length, 2)
})

test('clears heightSeen and commitRetry bookkeeping at/below head', () => {
    reset()
    const h = global.chain.getLatestBlock()._id
    consensus.heightSeen = { [h - 1]: 1, [h]: 2, [h + 1]: 3 }
    consensus.commitRetry = { [h - 1]: setTimeout(() => {}, 10000), [h + 1]: setTimeout(() => {}, 10000) }
    consensus.pruneStaleCandidates()
    assert.ok(!(String(h - 1) in consensus.heightSeen))
    assert.ok(!(String(h) in consensus.heightSeen))
    assert.ok(String(h + 1) in consensus.heightSeen)
    assert.ok(!(String(h - 1) in consensus.commitRetry))
    assert.ok(String(h + 1) in consensus.commitRetry)
    clearTimeout(consensus.commitRetry[h + 1])
})

test('frees capacity so a new candidate can be precommitted', () => {
    reset()
    const h = global.chain.getLatestBlock()._id
    // Simulate a full possBlocks array from stale equivocation candidates.
    for (let i = 0; i < 8; i++) consensus.possBlocks.push(pb(h - 2, 'stale' + i))
    assert.ok(consensus.possBlocks.length >= 2 * 4, 'precondition: at capacity')
    consensus.pruneStaleCandidates()
    assert.strictEqual(consensus.possBlocks.length, 0)
    // A fresh candidate for the next height now fits.
    consensus.possBlocks.push(pb(h + 1, 'fresh'))
    assert.strictEqual(consensus.possBlocks.length, 1)
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
