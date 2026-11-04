// == Pending block queue (Layer S/H) ==
// node test/pending-blocks.js

const assert = require('assert')

// Stub globals used by chain.js
if (typeof global.config === 'undefined')
    global.config = {
        maxDrift: 5000,
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    }
if (typeof global.logr === 'undefined')
    global.logr = { warn: () => {}, debug: () => {}, error: () => {} }

// Prevent logger.js from loading log4js appenders during chain.js require.
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
    chain.pendingBlocks = []
    if (chain.pendingBlockTimer) {
        clearTimeout(chain.pendingBlockTimer)
        chain.pendingBlockTimer = null
    }
}

console.log('=== Pending block queue ===\n')

test('addPendingBlock stores a future-dated block', () => {
    reset()
    const block = { _id: 1, hash: 'a', timestamp: Date.now() + 10000 }
    chain.addPendingBlock(block)
    assert.strictEqual(chain.pendingBlocks.length, 1)
    assert.strictEqual(chain.pendingBlocks[0].block.hash, 'a')
})

test('addPendingBlock deduplicates by hash', () => {
    reset()
    const block = { _id: 1, hash: 'a', timestamp: Date.now() + 10000 }
    chain.addPendingBlock(block)
    chain.addPendingBlock(block)
    assert.strictEqual(chain.pendingBlocks.length, 1)
})

test('addPendingBlock caps the queue and drops oldest', () => {
    reset()
    for (let i = 0; i < 105; i++)
        chain.addPendingBlock({ _id: i, hash: 'h' + i, timestamp: Date.now() + 10000 })
    assert.strictEqual(chain.pendingBlocks.length, 100)
    assert.strictEqual(chain.pendingBlocks[0].block.hash, 'h5')
})

test('processPendingBlocks drops stale entries', () => {
    reset()
    chain.pendingBlocks.push({ block: { _id: 1, hash: 'old', timestamp: Date.now() - 10000 }, added: Date.now() - 130000 })
    chain.processPendingBlocks()
    assert.strictEqual(chain.pendingBlocks.length, 0)
})

test('processPendingBlocks keeps blocks still in the future', () => {
    reset()
    const block = { _id: 1, hash: 'future', timestamp: Date.now() + 30000 }
    chain.addPendingBlock(block)
    chain.processPendingBlocks()
    assert.strictEqual(chain.pendingBlocks.length, 1)
})

test('processPendingBlocks honours config.pendingBlockMaxMs', () => {
    reset()
    const saved = config.pendingBlockMaxMs
    config.pendingBlockMaxMs = 1000
    chain.pendingBlocks.push({ block: { _id: 1, hash: 'stale', timestamp: Date.now() + 60000 }, added: Date.now() - 5000 })
    chain.processPendingBlocks()
    assert.strictEqual(chain.pendingBlocks.length, 0, 'past pendingBlockMaxMs the entry is dropped')
    config.pendingBlockMaxMs = saved
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
