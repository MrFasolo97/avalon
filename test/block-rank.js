// == Chain-derived deterministic block rank (Layer S/H) ==
// node test/block-rank.js

const assert = require('assert')

// Stub globals
if (typeof global.config === 'undefined')
    global.config = {
        leaders: 3,
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    }
if (typeof global.logr === 'undefined')
    global.logr = { warn: () => {}, debug: () => {}, error: () => {} }

require.cache[require.resolve('../src/logger')] = { exports: global.logr }

const chain = require('../src/chain')

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
    chain.schedule = { shuffle: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }] }
    chain.recentBlocks = []
}

console.log('=== Block rank ===\n')

test('scheduled miner has ladder position 0', () => {
    reset()
    const block = { _id: 1, miner: 'alice', timestamp: 1000, hash: 'h1' }
    const rank = chain.deriveBlockRank(block)
    assert.strictEqual(rank.ladderPos, 0)
})

test('backup miner has ladder position > 0', () => {
    reset()
    // Height 2: scheduled is bob; alice is a backup because she mined height 1.
    chain.recentBlocks = [{ _id: 1, miner: 'alice', hash: 'h0', timestamp: 500 }]
    const block = { _id: 2, miner: 'alice', timestamp: 1000, hash: 'h1' }
    const rank = chain.deriveBlockRank(block)
    assert.strictEqual(rank.ladderPos, 1)
})

test('earlier timestamp wins regardless of ladder position', () => {
    reset()
    const a = { _id: 1, miner: 'alice', timestamp: 1000, hash: 'a' }
    const b = { _id: 1, miner: 'bob', timestamp: 999, hash: 'b' }
    assert.ok(chain.compareBlockRank(chain.deriveBlockRank(a), chain.deriveBlockRank(b)) > 0)
})

test('same timestamp: scheduled leader wins over backup', () => {
    reset()
    const a = { _id: 1, miner: 'alice', timestamp: 1000, hash: 'a' }
    const b = { _id: 1, miner: 'bob', timestamp: 1000, hash: 'b' }
    assert.ok(chain.compareBlockRank(chain.deriveBlockRank(a), chain.deriveBlockRank(b)) < 0)
})

test('same timestamp and ladder position: lower hash wins', () => {
    reset()
    const a = { _id: 1, miner: 'alice', timestamp: 1000, hash: 'aaa' }
    const b = { _id: 1, miner: 'alice', timestamp: 1000, hash: 'bbb' }
    assert.ok(chain.compareBlockRank(chain.deriveBlockRank(a), chain.deriveBlockRank(b)) < 0)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
