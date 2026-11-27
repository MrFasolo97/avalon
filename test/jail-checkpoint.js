/* eslint-disable no-magic-numbers */
// == R5: persisted jail checkpoint (incremental restart, snapshot/rollback) ==
// node test/jail-checkpoint.js
//
// No MongoDB daemon is needed: the collection API is stubbed in memory. Uses
// the REAL leaderHealth checkpoint helpers and chain.rebuildLeaderHealth.

const assert = require('assert')
const { makeDb } = require('./lib/fakeMongoDb')

let passed = 0
let failed = 0
function test(name, fn) {
    return Promise.resolve().then(fn).then(() => {
        console.log('  PASS: ' + name)
        passed++
    }).catch(e => {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        if (process.env.DEBUG_TESTS) console.error(e)
        failed++
    })
}

global.logr = { info(){}, warn(){}, debug(){}, error(){}, trace(){}, cons(){}, fatal(){} }
require.cache[require.resolve('../src/logger')] = { exports: global.logr }

const H_JAIL = 100
const chainConfig = (h) => ({
    b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
    leaders: 3,
    jailMissThreshold: 3,
    jailBlocks: 10,
    jailBackoffMax: 2,
    jailEnabled: h >= H_JAIL,
    quorumEligibility: h >= H_JAIL ? 'lastTurn' : 'activeLeaders'
})
global.config = Object.assign({}, chainConfig(0), {
    activationHeight: (key) => key === 'jailEnabled' ? H_JAIL : Infinity,
    read: chainConfig
})
function stub(rel, exports) { require.cache[require.resolve(rel)] = { exports } }
stub('../src/config.js', { read: (h) => chainConfig(h) })

let store = []
const rangeCalls = []
stub('../src/blocks', {
    isOpen: true,
    readRange: (from, to) => { rangeCalls.push([from, to]); return store.filter(b => b._id >= from && b._id <= to) },
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
global.db = makeDb('avalon')

const chain = require('../src/chain')
const leaderHealth = require('../src/leaderHealth')
const stateSnapshot = require('../src/stateSnapshot')

const schedule = { shuffle: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }
const HEAD = H_JAIL + 400
const CP = H_JAIL + 200

// Deterministic chain: 'b' misses every scheduled turn, gets jailed, serves
// jail, produces once (clears probation), then misses again (level 2).
store = []
for (let h = H_JAIL - 5; h <= HEAD; h++) {
    const scheduled = schedule.shuffle[(h - 1) % 3].name
    const miss = scheduled === 'b' && h > H_JAIL
    store.push({ _id: h, miner: miss ? 'a' : scheduled, skips: miss ? ['b'] : [], txs: [], hash: 'h' + h })
}

const fold = (from, to, cp) => {
    leaderHealth.leaders = cp ? JSON.parse(JSON.stringify(cp.leaders)) : {}
    for (const b of store)
        if (b._id >= from && b._id <= to) leaderHealth.processBlock(b, schedule)
    return JSON.parse(JSON.stringify(leaderHealth.leaders))
}
const snap = (h) => {
    const out = {}
    for (const name in leaderHealth.leaders)
        out[name] = Object.assign({}, leaderHealth.leaders[name], { jailed: leaderHealth.isJailed(name, h) })
    return out
}
const setHead = (h) => { chain.getLatestBlock = () => ({ _id: h, hash: 'h' + h }) }
const rebuild = (cp) => new Promise((rs, rj) => chain.rebuildLeaderHealth((e, n) => e ? rj(e) : rs(n), cp))

console.log('=== R5: jail checkpoint ===\n')

test('checkpoint collection is part of derived state snapshots', () => {
    assert.ok(stateSnapshot.collections.indexOf('jailCheckpoint') !== -1)
})

;(async () => {
    // Reference: a node that never restarted folds the entire history.
    setHead(HEAD)
    const full = fold(H_JAIL - 5, HEAD)

    await test('persisted incremental state matches a full rebuild', async () => {
        await global.db.collection('jailCheckpoint').deleteMany({})
        const atCp = fold(H_JAIL - 5, CP)
        assert.ok(atCp.b && atCp.b.jail && atCp.b.jail.active, 'leader b must be jailed at checkpoint height')
        const ok = await leaderHealth.persistCheckpoint(CP)
        assert.strictEqual(ok, true)
        const doc = await leaderHealth.loadCheckpoint()
        assert.strictEqual(doc.lastProcessedHeight, CP)
        assert.deepStrictEqual(doc.leaders, atCp)
    })

    await test('restart folds only checkpoint+1..head and matches the full fold', async () => {
        const cp = await leaderHealth.loadCheckpoint()
        rangeCalls.length = 0
        setHead(HEAD)
        await rebuild(cp)
        assert.deepStrictEqual(rangeCalls, [[CP + 1, HEAD]],
            'restart must not rescan history below the checkpoint')
        assert.deepStrictEqual(snap(HEAD), snapFrom(full, HEAD))
    })

    await test('a missing checkpoint falls back to the full activation fold', async () => {
        await global.db.collection('jailCheckpoint').deleteMany({})
        rangeCalls.length = 0
        setHead(HEAD)
        await rebuild(null)
        assert.deepStrictEqual(rangeCalls, [[H_JAIL, HEAD]])
        assert.deepStrictEqual(snap(HEAD), snapFrom(full, HEAD))
    })

    await test('a checkpoint ahead of the head is never trusted', async () => {
        fold(H_JAIL - 5, CP)
        await leaderHealth.persistCheckpoint(HEAD + 100)
        rangeCalls.length = 0
        setHead(HEAD)
        await rebuild(await leaderHealth.loadCheckpoint())
        assert.deepStrictEqual(rangeCalls, [[H_JAIL, HEAD]])
        assert.deepStrictEqual(snap(HEAD), snapFrom(full, HEAD))
    })

    await test('snapshot save/restore carries the checkpoint and its leaders', async () => {
        process.env.AUTO_ROLLBACK = '1'
        await global.db.collection('state').updateOne(
            { _id: 0 }, { $set: { headBlock: CP } }, { upsert: true })
        fold(H_JAIL - 5, CP)
        await leaderHealth.persistCheckpoint(CP)
        assert.strictEqual(await stateSnapshot.save(CP), true)
        // Simulate rollback: live checkpoint is lost, snapshot restore recovers it.
        await global.db.collection('jailCheckpoint').deleteMany({})
        const restored = await stateSnapshot.restore(CP)
        assert.strictEqual(restored, CP)
        const cp = await leaderHealth.loadCheckpoint()
        assert.strictEqual(cp.lastProcessedHeight, CP)
        assert.deepStrictEqual(cp.leaders, fold(H_JAIL - 5, CP))
        await global.db.collection('stateSnapshot_' + CP + '_jailCheckpoint').deleteMany({})
        await global.db.collection('stateSnapshots').deleteMany({ _id: CP })
        delete process.env.AUTO_ROLLBACK
    })

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED')
        + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
})()

function snapFrom(leaders, h) {
    const saved = leaderHealth.leaders
    leaderHealth.leaders = JSON.parse(JSON.stringify(leaders))
    const out = snap(h)
    leaderHealth.leaders = saved
    return out
}
