// == F5: the early-check bypass list is chain data (config), not an env var ==
// node test/skip-early.js
//
// A per-node SKIP_EARLY_CHECK_BLOCKS let two nodes disagree on block validity at
// the same height. The bypass is now config.skipEarlyCheckBlocks (chain data).

const assert = require('assert')

// The deprecated env var must have no effect on the decision.
process.env.SKIP_EARLY_CHECK_BLOCKS = '9999999'

// Stub globals
if (typeof global.config === 'undefined')
    global.config = {
        leaders: 3,
        leaderStandbys: 2,
        skipEarlyCheckBlocks: [3889058],
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    }
if (typeof global.logr === 'undefined')
    global.logr = { warn: () => {}, debug: () => {}, error: () => {}, info: () => {} }

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

console.log('=== Early-check bypass (F5) ===\n')

test('the configured height is skipped', () => {
    config.skipEarlyCheckBlocks = [3889058]
    assert.strictEqual(chain.isEarlyCheckSkipped(3889058), true)
})

test('a height not in the list is not skipped', () => {
    config.skipEarlyCheckBlocks = [3889058]
    assert.strictEqual(chain.isEarlyCheckSkipped(4000000), false)
})

test('the deprecated env var has no effect (chain data is authoritative)', () => {
    config.skipEarlyCheckBlocks = [3889058]
    assert.strictEqual(chain.isEarlyCheckSkipped(9999999), false)
})

test('a missing or non-array list skips nothing (fail closed)', () => {
    config.skipEarlyCheckBlocks = undefined
    assert.strictEqual(chain.isEarlyCheckSkipped(3889058), false)
    config.skipEarlyCheckBlocks = '3889058'
    assert.strictEqual(chain.isEarlyCheckSkipped(3889058), false)
    config.skipEarlyCheckBlocks = [3889058]
})

test('the real config.js carries skipEarlyCheckBlocks at every height', () => {
    const real = require('../src/config.js')
    for (const h of [0, 241600, 13325000, 13400000]) {
        const c = real.read(h)
        assert.ok(Array.isArray(c.skipEarlyCheckBlocks), 'not an array at h=' + h)
        assert.ok(c.skipEarlyCheckBlocks.indexOf(3889058) !== -1, 'default missing at h=' + h)
    }
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
