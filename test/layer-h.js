// == Layer H: canonical leader set, standby pool, strict skip validation ==
// node test/layer-h.js

const assert = require('assert')

// Stub globals
if (typeof global.config === 'undefined')
    global.config = {
        leaders: 3,
        leaderStandbys: 2,
        canonicalLeaderOrder: true,
        skipStrict: true,
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    }
if (typeof global.logr === 'undefined')
    global.logr = { warn: () => {}, debug: () => {}, error: () => {}, info: () => {} }

require.cache[require.resolve('../src/logger')] = { exports: global.logr }

const chain = require('../src/chain')
const leaderHealth = require('../src/leaderHealth')

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
    chain.getLatestBlock = () => ({ _id: 100, hash: 'head' })
    chain.schedule = { shuffle: [] }
    leaderHealth.leaders = {}
}

function leaders(n) {
    const arr = []
    for (let i = 0; i < n; i++)
        arr.push({
            name: 'l' + i,
            pub: 'pub' + i,
            pub_leader: 'lpub' + i,
            node_appr: (n - i) * 1000
        })
    return arr
}

console.log('=== Layer H ===\n')

test('activeLeaderSet returns top N in canonical order', () => {
    reset()
    chain.generateLeaders = () => leaders(5)
    const active = chain.activeLeaderSet()
    assert.strictEqual(active.length, 3)
    assert.deepStrictEqual(active.map(l => l.name), ['l0', 'l1', 'l2'])
})

test('activeLeaderSet excludes jailed leaders', () => {
    reset()
    const all = leaders(5)
    chain.generateLeaders = () => all
    // Jail l1
    leaderHealth.leaders['l1'] = {
        produced: 0, missed: 0, streak: 0,
        jail: { active: true, untilBlock: 200, probation: false }
    }
    const active = chain.activeLeaderSet()
    assert.strictEqual(active.length, 3)
    assert.deepStrictEqual(active.map(l => l.name), ['l0', 'l2', 'l3'])
})

test('standbyLeaderSet returns the slice below the active cut', () => {
    reset()
    chain.generateLeaders = () => leaders(6)
    const standby = chain.standbyLeaderSet()
    assert.strictEqual(standby.length, 2)
    assert.deepStrictEqual(standby.map(l => l.name), ['l3', 'l4'])
})

test('legacy mode falls back to generateLeaders top N', () => {
    reset()
    config.canonicalLeaderOrder = false
    chain.generateLeaders = (withPub, withWs, limit) => leaders(limit)
    const active = chain.activeLeaderSet()
    assert.strictEqual(active.length, 3)
    config.canonicalLeaderOrder = true
})

console.log('\n--- skip attestation (chain.checkSkipAttestation) ---')

test('accepts the canonical prefix', () => {
    assert.deepStrictEqual(chain.checkSkipAttestation(['a', 'b'], ['a', 'b'], 'c'), { ok: true })
    assert.deepStrictEqual(chain.checkSkipAttestation([], [], 'a'), { ok: true })
})

test('an absent attestation is reported, not silently accepted', () => {
    assert.strictEqual(chain.checkSkipAttestation(undefined, [], 'a').reason, 'absent')
})

test('rejects a non-canonical prefix', () => {
    assert.strictEqual(chain.checkSkipAttestation(['b', 'a'], ['a', 'b'], 'c').reason, 'mismatch')
    assert.strictEqual(chain.checkSkipAttestation(['a'], ['a', 'b'], 'c').reason, 'mismatch')
})

test('rejects duplicates, the miner itself, bad names and overflow', () => {
    assert.strictEqual(chain.checkSkipAttestation(['a', 'a'], ['a'], 'c').reason, 'duplicate')
    assert.strictEqual(chain.checkSkipAttestation(['a'], ['a'], 'a').reason, 'miner-in-skips')
    assert.strictEqual(chain.checkSkipAttestation(['a', 7], ['a'], 'c').reason, 'bad-name')
    assert.strictEqual(chain.checkSkipAttestation(['a', ''], ['a'], 'c').reason, 'bad-name')
    // config.leaders(3) + leaderStandbys(2) = 5
    assert.strictEqual(chain.checkSkipAttestation(['n0', 'n1', 'n2', 'n3', 'n4', 'n5'], [], 'c').reason, 'too-many')
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
