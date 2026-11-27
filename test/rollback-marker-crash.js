/* eslint-disable no-magic-numbers */
// == R9 integration: rollback marker survives a state-swap crash ==
// node test/rollback-marker-crash.js
//
// Uses the REAL mongo.js marker/swap/recovery code with the in-memory Mongo
// harness. Simulates a crash immediately after `finalizeRebuildSwap` renames
// the `state` collection and before the `swapped` transition is written, then
// runs the same startup recovery main.js uses.

const assert = require('assert')
const { makeClient, stateSnapshotOf } = require('./lib/fakeMongoDb')

process.env.AUTO_ROLLBACK = '1'
process.env.REBUILD_NO_VALIDATE = '1'
delete process.env.NOTIFICATIONS
delete process.env.BLOCKS_DIR

global.config = {
    b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
    maxTxPerBlock: 200, jsonMaxBytes: 60000, leaders: 5, blockTime: 3000,
    ecoBlocks: 10, ecoBlocksIncreasesSoon: false, txExpirationTime: 1000000,
    originHash: 'origin', maxReorgDepth: 10, read: () => global.config
}
global.logr = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, cons: () => {}, econ: () => {}
}
require.cache[require.resolve('../src/logger')] = { exports: global.logr }

global.cache = { rollback: () => {}, clear: () => {}, processRebuildOps: (cb) => cb() }
const mongo = require('../src/mongo')
const stateSnapshot = require('../src/stateSnapshot')
const rollbackRecovery = require('../src/rollbackRecovery')
const blocks = require('../src/blocks')
assert.strictEqual(blocks.isOpen, false, 'marker crash test must use the Mongo block store')
const chain = require('../src/chain')
global.chain = chain

const dao = require('../src/dao')
const daoMaster = require('../src/daoMaster')
const eco = require('../src/economics')
const notifications = require('../src/notifications')
const leaderHealth = require('../src/leaderHealth')
const leaderStats = require('../src/leaderStats')
global.eco = eco
global.dao = dao
global.daoMaster = daoMaster
global.notifications = notifications
global.leaderHealth = leaderHealth
global.leaderStats = leaderStats
for (const mod of [dao, daoMaster]) mod.nextBlock = () => {}
eco.nextBlock = () => {}
eco.appendHistory = () => {}
eco.cleanHistory = () => {}
notifications.processBlock = () => {}
leaderHealth.processBlock = () => {}
leaderStats.processBlock = () => {}
chain.output = () => {}
chain.cleanMemory = () => {}
chain.saveSchedule = () => {}
chain.minerSchedule = () => ({ shuffle: [] })
chain.executeBlockTransactions = (block, revalidate, cb) => {
    void (async () => {
        for (const tx of block.txs) {
            const account = await global.db.collection('accounts').findOne({ name: 'alice' })
            const balance = (account ? account.balance : 0) + tx.data.delta
            await global.db.collection('accounts').updateOne({ name: 'alice' }, { $set: { balance } })
        }
        await global.db.collection('state').updateOne(
            { _id: 0 }, { $set: { headBlock: block._id } }, { upsert: true })
        cb(block.txs.slice(), 0, 0)
    })()
}

const SNAPSHOT_HEIGHT = 3
const ANCESTOR = 5
const FORK_HEAD = 8

const canonBlock = (height) => ({
    _id: height, phash: 'canon-' + (height - 1), timestamp: 1600000000000 + height * 3000,
    txs: height === 0 ? [] : [{ hash: 'canon-tx-' + height, data: { delta: height } }],
    miner: 'miner1', dist: 0, burn: 0, hash: 'canon-' + height
})
const forkBlock = (height) => ({
    _id: height, phash: 'canon-' + (height - 1), timestamp: 1600000000000 + height * 3000,
    txs: [{ hash: 'fork-tx-' + height, data: { delta: 100 + height } }],
    miner: 'miner1', dist: 0, burn: 0, hash: 'fork-' + height
})

async function freshDb() {
    // The client must own the registry: R8 copies snapshot collections with a
    // cross-database `$out`, so every db created from it can resolve the temp
    // rebuild database. A bare makeDb() has no registry and would fail here.
    mongo.client = makeClient()
    const db = mongo.client.db('avalon')
    global.db = db
    mongo.db = db
    mongo.dbName = 'avalon'
    mongo._rebuildContext = null
    mongo._rebuildOriginalDb = null
    chain.blocksToRebuild = []
    chain.recentBlocks = []

    await db.collection('accounts').insertOne({ name: 'alice', balance: 0 })
    await db.collection('state').insertOne({ _id: 0, headBlock: 0 })
    for (let h = 0; h <= ANCESTOR; h++) await db.collection('blocks').insertOne(canonBlock(h))
    for (let h = ANCESTOR + 1; h <= FORK_HEAD; h++) await db.collection('blocks').insertOne(forkBlock(h))

    const apply = async (list) => {
        for (const block of list)
            for (const tx of block.txs) {
                const account = await db.collection('accounts').findOne({ name: 'alice' })
                await db.collection('accounts').updateOne({ name: 'alice' },
                    { $set: { balance: account.balance + tx.data.delta } })
            }
        await db.collection('state').updateOne({ _id: 0 },
            { $set: { headBlock: list[list.length - 1]._id } }, { upsert: true })
    }
    const canonical = []
    for (let h = 0; h <= ANCESTOR; h++) canonical.push(canonBlock(h))
    const fork = []
    for (let h = ANCESTOR + 1; h <= FORK_HEAD; h++) fork.push(forkBlock(h))
    await apply(canonical.slice(0, SNAPSHOT_HEIGHT + 1))
    await stateSnapshot.save(SNAPSHOT_HEIGHT)
    await apply(canonical.slice(SNAPSHOT_HEIGHT + 1))
    await apply(fork)
    assert.strictEqual((await stateSnapshotOf(db)).headBlock, FORK_HEAD)
    return db
}

function simulateRestart(db) {
    // A process restart drops all in-memory rebuild context; Mongo still holds
    // the swapped state, the marker and the untruncated block tail.
    mongo._rebuildContext = null
    mongo._rebuildOriginalDb = null
    global.db = db
    mongo.db = db
}

let passed = 0
let failed = 0
async function test(name, fn) {
    try {
        await fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' \u2014 ' + e.message)
        if (process.env.DEBUG_TESTS) console.error(e)
        failed++
    }
}

async function main() {
    console.log('=== R9: rollback marker crash recovery ===\n')

    await test('marker lives in its own collection and snapshots never copy it', async () => {
        const db = await freshDb()
        assert.strictEqual(mongo.rollbackMarkerCollection, 'rollback_marker')
        assert.strictEqual(stateSnapshot.collections.indexOf('rollback_marker'), -1)
        await mongo.setRollbackMarker({ phase: 'started', ancestor: ANCESTOR, fromHeight: FORK_HEAD })
        const marker = await db.collection('rollback_marker').findOne({ _id: 'rollback' })
        assert.strictEqual(marker.phase, 'started')
        assert.strictEqual(marker.ancestor, ANCESTOR)
        assert.strictEqual(await db.collection('state').findOne({ _id: 'rollback' }), null,
            'the marker must not be stored in the swapped state collection')

        await stateSnapshot.save(FORK_HEAD)
        assert.strictEqual(await db.collection('stateSnapshot_8_rollback_marker').countDocuments(), 0,
            'snapshot creation must not copy the marker collection')
        const snapshotState = await db.collection('stateSnapshot_8_state').find({}).toArray()
        assert.strictEqual(snapshotState.some(d => d._id === 'rollback'), false)
    })

    await test('a pre-swap crash discards the temp DB and leaves blocks untouched', async () => {
        const db = await freshDb()
        await mongo.setRollbackMarker({ phase: 'started', ancestor: ANCESTOR, fromHeight: FORK_HEAD })
        const snapshotHeight = await mongo.resetDerivedState(SNAPSHOT_HEIGHT)
        assert.strictEqual(snapshotHeight, SNAPSHOT_HEIGHT)
        simulateRestart(db)

        const result = await rollbackRecovery.recover({ mongo, blocks, logr: global.logr })
        assert.strictEqual(result.action, 'discarded-before-swap')
        assert.ok(await db.collection('blocks').findOne({ _id: FORK_HEAD }),
            'no truncation before the swap')
        assert.strictEqual(await mongo.getRollbackMarker(), null)
        assert.strictEqual(Object.keys(mongo.client.db('avalon_rebuild_tmp')._collections).length, 0)
    })

    await test('crash after state rename: marker survives, recovery truncates the tail', async () => {
        const db = await freshDb()
        await mongo.setRollbackMarker({
            phase: 'started', ancestor: ANCESTOR, fromHeight: FORK_HEAD,
            targetHeight: 10, targetHash: 'majority'
        })
        const snapshotHeight = await mongo.resetDerivedState(SNAPSHOT_HEIGHT)
        assert.strictEqual(snapshotHeight, SNAPSHOT_HEIGHT)
        const builtTo = await new Promise((rs, rj) => chain.rebuildState(
            SNAPSHOT_HEIGHT + 1, ANCESTOR, (e, to) => e ? rj(e) : rs(to)))
        assert.strictEqual(builtTo, ANCESTOR)

        await assert.rejects(() => mongo.finalizeRebuildSwap({
            afterRename: (name) => {
                if (name === 'state') throw new Error('simulated crash after state rename')
            }
        }), /simulated crash after state rename/)

        const survived = await mongo.getRollbackMarker()
        assert.ok(survived, 'the started marker must survive the state collection rename')
        assert.strictEqual(survived.phase, 'started', 'swapped marker was never written')
        assert.strictEqual(survived.swapping, true)
        assert.strictEqual(survived.ancestor, ANCESTOR)
        assert.strictEqual((await db.collection('state').findOne({ _id: 0 })).headBlock, ANCESTOR)
        assert.ok(await db.collection('blocks').findOne({ _id: FORK_HEAD }),
            'orphan tail is still on disk at the crash point')

        simulateRestart(db)
        const result = await rollbackRecovery.recover({ mongo, blocks, logr: global.logr })
        assert.strictEqual(result.action, 'truncated-after-swap')
        assert.strictEqual(result.ancestor, ANCESTOR)
        assert.strictEqual(result.head._id, ANCESTOR)
        assert.strictEqual(await db.collection('blocks').findOne({ _id: FORK_HEAD }), null,
            'startup recovery must truncate the untruncated blocks')
        assert.ok(await db.collection('blocks').findOne({ _id: ANCESTOR }))
        assert.strictEqual(await mongo.getRollbackMarker(), null,
            'recovery must clear the marker only after truncation')
        assert.strictEqual(Object.keys(mongo.client.db('avalon_rebuild_tmp')._collections).length, 0)
        const leftovers = (await db.listCollections().toArray())
            .filter(row => row.name.indexOf('_rebuild_incoming') !== -1)
        assert.strictEqual(leftovers.length, 0, 'staging collections must be cleaned up')
    })

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
