// == Force-finalize block fetch (Layer S/H) ==
// node test/force-finalize-fetch.js

const assert = require('assert')

// Stub globals used by consensus.js
if (typeof global.config === 'undefined')
    global.config = { b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz' }
if (typeof global.chain === 'undefined')
    global.chain = { getLatestBlock: () => ({ _id: 0, hash: 'genesis' }) }
if (typeof global.logr === 'undefined')
    global.logr = { debug: () => {}, cons: () => {}, warn: () => {}, error: () => {}, info: () => {} }
if (typeof global.p2p === 'undefined')
    global.p2p = { broadcast: () => {} }

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
}

console.log('=== Force-finalize fetch ===\n')

test('findPossBlockByHash returns null when queue empty', () => {
    reset()
    assert.strictEqual(consensus.findPossBlockByHash('abc'), null)
})

test('findPossBlockByHash finds a block by hash', () => {
    reset()
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'aaa', miner: 'alice' } },
        { block: { _id: 1, hash: 'bbb', miner: 'bob' } }
    ]
    const found = consensus.findPossBlockByHash('bbb')
    assert.ok(found)
    assert.strictEqual(found.block.miner, 'bob')
})

test('requestForceFinalizeBlocks broadcasts only missing hashes', () => {
    reset()
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'aaa', miner: 'alice' } }
    ]
    let broadcasted = null
    global.p2p.broadcast = (msg) => { broadcasted = msg }
    consensus.requestForceFinalizeBlocks(1, ['aaa', 'bbb', 'ccc'])
    assert.ok(broadcasted)
    assert.strictEqual(broadcasted.t, 8)
    assert.deepStrictEqual(broadcasted.d.hashes, ['bbb', 'ccc'])
})

test('requestForceFinalizeBlocks does nothing when all hashes are local', () => {
    reset()
    consensus.possBlocks = [
        { block: { _id: 1, hash: 'aaa', miner: 'alice' } }
    ]
    let broadcasted = null
    global.p2p.broadcast = (msg) => { broadcasted = msg }
    consensus.requestForceFinalizeBlocks(1, ['aaa'])
    assert.strictEqual(broadcasted, null)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
