// == Schedule determinism (F6) ==
// node test/schedule-determinism.js
//
// generateLeaders() is the input to minerSchedule()'s Fisher-Yates shuffle. It
// must return the SAME order on every node for the same account set, otherwise
// two nodes build different shuffles, disagree on who the round leader is, and
// produce different blocks at the same height.

const assert = require('assert')

if (typeof global.config === 'undefined')
    global.config = { leaders: 3, b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz' }
if (typeof global.logr === 'undefined')
    global.logr = { warn() {}, debug() {}, error() {}, info() {}, cons() {}, trace() {}, fatal() {} }

require.cache[require.resolve('../src/logger')] = { exports: global.logr }

global.cache = { accounts: {}, leaders: {} }
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

// Fill the cache with accounts at a given node_appr, inserted in `order`.
function setup(order, apprOf) {
    cache.accounts = {}
    cache.leaders = {}
    for (const name of order) {
        const appr = apprOf ? apprOf(name) : 1000
        cache.accounts[name] = {
            name: name, pub: 'p-' + name, pub_leader: 'l-' + name,
            balance: 1, approves: [], node_appr: appr
        }
        cache.leaders[name] = 1
    }
}

const names = ['carol', 'alice', 'bob', 'eve', 'dave']

console.log('=== Schedule determinism (F6) ===')

test('equal node_appr: order is insertion-independent (name tie-break)', () => {
    setup(names)
    const a = chain.generateLeaders(true, false, 100, 0).map(l => l.name)
    setup([...names].reverse())
    const b = chain.generateLeaders(true, false, 100, 0).map(l => l.name)
    assert.deepStrictEqual(a, b)
    // ties broken by name ascending
    assert.deepStrictEqual(a, ['alice', 'bob', 'carol', 'dave', 'eve'])
})

test('orders by node_appr descending, then name ascending', () => {
    const appr = { zed: 2000, amy: 1000, bob: 1000, cid: 3000 }
    setup(Object.keys(appr), n => appr[n])
    const out = chain.generateLeaders(true, false, 100, 0).map(l => l.name)
    assert.deepStrictEqual(out, ['cid', 'zed', 'amy', 'bob'])
})

test('limit + start slice the canonical order', () => {
    setup(names)
    const top3 = chain.generateLeaders(true, false, 3, 0).map(l => l.name)
    assert.deepStrictEqual(top3, ['alice', 'bob', 'carol'])
    const next2 = chain.generateLeaders(true, false, 5, 3).map(l => l.name)
    assert.deepStrictEqual(next2, ['dave', 'eve'])
})

test('accounts without a leader key are excluded', () => {
    setup(names)
    delete cache.accounts['bob'].pub_leader
    const out = chain.generateLeaders(true, false, 100, 0).map(l => l.name)
    assert.ok(out.indexOf('bob') === -1)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
