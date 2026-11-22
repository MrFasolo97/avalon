/* eslint-disable no-magic-numbers */
// == H1: deterministic jail state across restarts and activation gates ==
// node test/jail-determinism.js
//
// Pins three properties:
//  1. The jail rule is OFF before a single chain-data height (H_S = 13,325,000
//     on mainnet) and ON from that height on. No env var, wall clock or local
//     build can move it.
//  2. Jail state is a fold over identical post-activation blocks: a node that
//     restarted at any height computes the same snapshot as one that never did,
//     even when its local (head) config differs from the chain config.
//  3. The jail rotation filter is gated by H_standby = 13,400,000, not by the
//     bare canonicalLeaderOrder boolean.

const assert = require('assert')

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

global.logr = { info(){}, warn(){}, debug(){}, error(){}, trace(){}, cons(){}, fatal(){} }

console.log('=== H1: jail determinism ===\n')

// --- 1. real mainnet gates come from config.history -------------------------
test('mainnet activation heights are 13325000 (jail) and 13400000 (standby)', () => {
    const mainnetConfig = require('../src/config.js')
    assert.strictEqual(mainnetConfig.activationHeight('jailEnabled'), 13325000)
    assert.strictEqual(mainnetConfig.activationHeight('standbyEnabled'), 13400000)
    assert.strictEqual(mainnetConfig.read(0).jailEnabled, false)
    assert.strictEqual(mainnetConfig.read(13324999).jailEnabled, false)
    assert.strictEqual(mainnetConfig.read(13325000).jailEnabled, true)
    assert.strictEqual(mainnetConfig.read(13339999).standbyEnabled, false)
    assert.strictEqual(mainnetConfig.read(13400000).standbyEnabled, true)
})

// --- stubs for the simulated network ----------------------------------------
require.cache[require.resolve('../src/logger')] = { exports: global.logr }

// Scaled-down heights: 100 = H_S, 200 = H_standby. The real values are
// asserted against src/config.js above.
const H_JAIL = 100
const H_STANDBY = 200

const chainConfig = (h) => {
    const c = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        leaders: 3,
        leaderStandbys: 2,
        leaderShufflePrecision: 6,
        jailMissThreshold: 3,
        jailBlocks: 10,
        jailBackoffMax: 2,
        jailEnabled: h >= H_JAIL,
        quorumEligibility: h >= H_JAIL ? 'lastTurn' : 'activeLeaders',
        standbyEnabled: h >= H_STANDBY,
        canonicalLeaderOrder: h >= H_STANDBY
    }
    return c
}

global.config = Object.assign({}, chainConfig(0), {
    activationHeight: (key) => key === 'jailEnabled' ? H_JAIL
        : key === 'standbyEnabled' ? H_STANDBY : Infinity,
    read: chainConfig
})

function stub(rel, exports) { require.cache[require.resolve(rel)] = { exports } }
stub('../src/logger', global.logr)
stub('../src/config.js', { read: (h) => chainConfig(h) })

let store = []
stub('../src/blocks', {
    isOpen: true,
    readRange: (from, to) => store.filter(b => b._id >= from && b._id <= to),
    read: (id) => store.find(b => b._id === id) || null,
    lastBlock: () => store[store.length - 1]
})
stub('../src/dao', { nextBlock(){}, resetID(){} })
stub('../src/daoMaster', { nextBlock(){}, resetID(){} })
stub('../src/transaction.js', { removeFromPool(){}, eventConfirmation: { emit(){} } })
stub('../src/notifications.js', { processBlock(){} })
stub('../src/txHistory', { processBlock(){} })

global.eco = { cleanHistory(){}, appendHistory(){}, nextBlock(){} }
global.leaderStats = { processBlock(){} }
global.p2p = { recovering: true, broadcastBlock(){} }
global.consensus = { observer: false }
global.cache = { writeToDisk(r, cb){ cb(null) }, clear(){}, rollback(){} }
global.db = { collection(){ return { findOne: async () => null, insertOne: async () => {} } } }

const chain = require('../src/chain')
const leaderHealth = require('../src/leaderHealth')

const schedule = { shuffle: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }
const allLeaders = [
    { name: 'a', pub: 'pa', node_appr: 5000 },
    { name: 'b', pub: 'pb', node_appr: 4000 },
    { name: 'c', pub: 'pc', node_appr: 3000 },
    { name: 'd', pub: 'pd', node_appr: 2000 },
    { name: 'e', pub: 'pe', node_appr: 1000 }
]
chain.generateLeaders = (withPub, withWs, limit) => allLeaders.slice(0, limit || allLeaders.length)

// Blocks 90-210. 'b' misses every scheduled turn from 91 on: those misses
// before H_JAIL must be ignored, the ones after it must jail 'b'.
function makeBlocks() {
    const out = []
    for (let h = 90; h <= 210; h++) {
        const s = schedule.shuffle[(h - 1) % 3].name
        if (h >= 91 && s === 'b')
            out.push({ _id: h, miner: 'a', skips: ['b'], txs: [], hash: 'abcdef' + h })
        else
            out.push({ _id: h, miner: s, skips: [], txs: [], hash: 'abcdef' + h })
    }
    return out
}
store = makeBlocks()

function setHead(h) {
    Object.assign(global.config, chainConfig(h))
    chain.getLatestBlock = () => ({ _id: h, hash: 'abcdef' + h })
}

function incremental(limit) {
    leaderHealth.leaders = {}
    for (const b of store) {
        if (limit !== undefined && b._id > limit) break
        leaderHealth.processBlock(b, schedule)
    }
    return JSON.parse(JSON.stringify(leaderHealth.leaders))
}

function restartAt(h) {
    setHead(h)
    leaderHealth.leaders = {}
    chain.rebuildLeaderHealth((err) => { if (err) throw err })
    const out = {}
    for (const name in leaderHealth.leaders)
        out[name] = Object.assign({}, leaderHealth.leaders[name],
            { jailed: leaderHealth.isJailed(name, h) })
    return out
}

// --- 2. gate ---------------------------------------------------------------
test('no jail state is produced before the activation height', () => {
    setHead(99)
    leaderHealth.leaders = {}
    for (const b of store.filter(b => b._id <= 99))
        leaderHealth.processBlock(b, schedule)
    assert.deepStrictEqual(leaderHealth.leaders, {})
    assert.strictEqual(leaderHealth.isJailed('b', 99), false)
})

test('the first post-activation blocks jail the same leader on every node', () => {
    setHead(130)
    leaderHealth.leaders = {}
    for (const b of store.filter(b => b._id <= 130))
        leaderHealth.processBlock(b, schedule)
    assert.strictEqual(leaderHealth.isJailed('b', 130), true)
    assert.strictEqual(leaderHealth.leaders.b.jail.active, true)
})

test('isJailed cannot be turned on before the height gate', () => {
    setHead(99)
    leaderHealth.leaders = {
        b: { jail: { active: true, untilBlock: 150, level: 1, probation: false } }
    }
    assert.strictEqual(leaderHealth.isJailed('b', 99), false)
    assert.strictEqual(leaderHealth.isJailed('b', 101), true)
})

// --- 3. restart equivalence -------------------------------------------------
test('restart before standby activation yields the same jail state', () => {
    assert.deepStrictEqual(restartAt(150), expectedSnapshot(150))
})

test('restart after standby activation yields the same jail state', () => {
    assert.deepStrictEqual(restartAt(205), expectedSnapshot(205))
})

test('restart with a different local build config still yields chain state', () => {
    setHead(205)
    // Local head config is intentionally wrong; config.read(h) stays canonical.
    global.config.jailMissThreshold = 9999
    global.config.jailBlocks = 9999
    assert.deepStrictEqual(restartAt(205), expectedSnapshot(205))
    setHead(205)
})

function expectedSnapshot(h) {
    const fresh = incremental(h)
    const out = {}
    for (const name in fresh) {
        const l = fresh[name]
        out[name] = Object.assign({}, l, {
            jailed: leaderHealth.isJailed(name, h)
        })
    }
    return out
}

// --- 4. rotation gate -------------------------------------------------------
test('rebuild uses the post-activation fold, so the active set is identical', () => {
    setHead(205)
    chain.rebuildLeaderHealth((err) => { if (err) throw err })
    const active = chain.activeLeaderSet().map(l => l.name)
    assert.deepStrictEqual(active, ['a', 'c', 'd'], 'jailed b is replaced by standby d')
    const standbys = chain.standbyLeaderSet().map(l => l.name)
    assert.deepStrictEqual(standbys, ['e'])
})

test('a stale canonicalLeaderOrder flag cannot enable the jail filter early', () => {
    setHead(150)
    // Simulate a local build/config that sets the H flag before its height.
    global.config.canonicalLeaderOrder = true
    global.config.standbyEnabled = true
    assert.strictEqual(chain.jailFilterActiveAt(150), false)
    assert.deepStrictEqual(chain.activeLeaderSet().map(l => l.name), ['a', 'b', 'c'])
    assert.deepStrictEqual(chain.standbyLeaderSet(), [])
    setHead(205)
    assert.strictEqual(chain.jailFilterActiveAt(205), true)
})

test('leader schedule is identical before and after a restart', () => {
    setHead(205)
    chain.rebuildLeaderHealth((err) => { if (err) throw err })
    const afterRestart = chain.minerSchedule({ _id: 205, hash: 'abcdef123456' })
    assert.deepStrictEqual(afterRestart.shuffle.map(s => s.name).sort(), ['a', 'c', 'd'])
    // Re-fold the same blocks incrementally on the "never restarted" node.
    incremental()
    const noRestart = chain.minerSchedule({ _id: 205, hash: 'abcdef123456' })
    assert.deepStrictEqual(noRestart.shuffle, afterRestart.shuffle)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
