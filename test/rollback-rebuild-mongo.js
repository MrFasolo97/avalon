/* eslint-disable no-magic-numbers */
// == R7 integration: rollback rebuilds state from the Mongo block store ==
// node test/rollback-rebuild-mongo.js
//
// Same failure as the BSON suite but with blocks stored in MongoDB. During a
// rollback the global `db` is switched to the empty temp rebuild database, so
// chain.batchLoadBlocks MUST read through mongo.originalDb(). Nothing stubs
// chain.rebuildState: the rebuilt state is compared to a clean reference node.

const assert = require('assert')
const { makeDb, makeClient, stateSnapshotOf, stateHash } = require('./lib/fakeMongoDb')

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

const originalDb = makeDb()
global.db = originalDb
global.cache = { rollback: () => {}, clear: () => {}, processRebuildOps: (cb) => cb() }

const mongo = require('../src/mongo')
mongo.dbName = 'avalon'
mongo.db = originalDb
mongo.client = makeClient({ avalon: originalDb })

const stateSnapshot = require('../src/stateSnapshot')
const divergence = require('../src/divergence')
const blocks = require('../src/blocks')
assert.strictEqual(blocks.isOpen, false, 'Mongo suite must use the Mongo block store')
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

const canonBlock = (height, phash) => ({
    _id: height, phash, timestamp: 1600000000000 + height * 3000,
    txs: height === 0 ? [] : [{ hash: 'canon-tx-' + height, data: { delta: height } }],
    miner: 'miner1', dist: 0, burn: 0, hash: 'canon-' + height
})
const forkBlock = (height, phash) => ({
    _id: height, phash, timestamp: 1600000000000 + height * 3000,
    txs: [{ hash: 'fork-tx-' + height, data: { delta: 100 + height } }],
    miner: 'miner1', dist: 0, burn: 0, hash: 'fork-' + height
})

const storeBlocks = async (database, list) => {
    for (const block of list) await database.collection('blocks').insertOne(block)
}

const applyDeltas = async (database, list) => {
    for (const block of list)
        for (const tx of block.txs) {
            const account = await database.collection('accounts').findOne({ name: 'alice' })
            await database.collection('accounts').updateOne({ name: 'alice' },
                { $set: { balance: account.balance + tx.data.delta } })
        }
    await database.collection('state').updateOne({ _id: 0 },
        { $set: { headBlock: list[list.length - 1]._id } }, { upsert: true })
}

const initDb = async (database) => {
    await database.collection('accounts').insertOne({ name: 'alice', balance: 0 })
    await database.collection('state').insertOne({ _id: 0, headBlock: 0 })
}

const rebuild = (database, from, end) => {
    const previousDb = global.db
    global.db = database
    mongo.db = database
    mongo._rebuildOriginalDb = null
    chain.blocksToRebuild = []
    chain.recentBlocks = []
    return new Promise((rs, rj) => chain.rebuildState(from, end, (e, builtTo) => {
        if (e) return rj(e)
        rs(builtTo)
    })).finally(() => {
        global.db = previousDb
        mongo.db = previousDb
    })
}

let passed = 0
let failed = 0
async function test(name, fn) {
    try {
        await fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        if (process.env.DEBUG_TESTS) console.error(e)
        failed++
    }
}

async function main() {
    console.log('=== R7: rollback state rebuild (Mongo block store) ===\n')

    await test('rebuild reads original Mongo blocks while the temp DB is active', async () => {
        const canonical = [canonBlock(0, '0')]
        let phash = canonical[0].hash
        for (let h = 1; h <= ANCESTOR; h++) {
            const block = canonBlock(h, phash)
            canonical.push(block)
            phash = block.hash
        }
        const fork = []
        for (let h = ANCESTOR + 1; h <= FORK_HEAD; h++) {
            const block = forkBlock(h, phash)
            fork.push(block)
            phash = block.hash
        }
        await storeBlocks(originalDb, canonical.concat(fork))

        // Snapshot BELOW the ancestor so replay must cross it, then the losing
        // fork's derived state.
        await initDb(originalDb)
        global.db = originalDb
        mongo.db = originalDb
        await applyDeltas(originalDb, canonical.slice(0, SNAPSHOT_HEIGHT + 1))
        await stateSnapshot.save(SNAPSHOT_HEIGHT)
        await applyDeltas(originalDb, canonical.slice(SNAPSHOT_HEIGHT + 1))
        await applyDeltas(originalDb, fork)
        const diverged = await stateSnapshotOf(originalDb)
        assert.strictEqual(diverged.headBlock, FORK_HEAD)
        assert.strictEqual(diverged.accounts[0].balance, 15 + 106 + 107 + 108)

        // Clean reference node: same canonical blocks, no fork, real replay.
        const referenceDb = makeDb()
        await initDb(referenceDb)
        await storeBlocks(referenceDb, canonical)
        await applyDeltas(referenceDb, canonical.slice(0, SNAPSHOT_HEIGHT + 1))
        const referenceBuiltTo = await rebuild(referenceDb, SNAPSHOT_HEIGHT + 1, ANCESTOR)
        assert.strictEqual(referenceBuiltTo, ANCESTOR)
        const reference = await stateSnapshotOf(referenceDb)
        assert.strictEqual(reference.headBlock, ANCESTOR)
        assert.strictEqual(reference.accounts[0].balance, 15)

        global.db = originalDb
        mongo.db = originalDb
        mongo._rebuildOriginalDb = null
        mongo._rebuildContext = null
        let snapshotHeight = null
        let builtTo = null
        let activeDbDuringRebuild = null
        const decision = {
            shouldRollback: true, fromHeight: FORK_HEAD, ancestor: ANCESTOR,
            height: 10, hash: 'majority', signers: []
        }
        await divergence.rollback(decision, {
            logr: global.logr,
            events: { emit: () => {} },
            preflightSnapshot: (h) => mongo.preflightStateSnapshotAtOrBelow(h),
            markRollback: () => Promise.resolve(true),
            pause: () => { cache.rollback() },
            resetState: (h) => mongo.resetDerivedState(h).then(s => {
                snapshotHeight = s
                return true
            }),
            resetRuntime: () => { chain.blocksToRebuild = []; chain.recentBlocks = [] },
            rebuildState: (endHeight) => new Promise((rs, rj) => {
                activeDbDuringRebuild = global.db
                const from = Math.min(snapshotHeight + 1, endHeight + 1)
                chain.rebuildState(from, endHeight, (e, to) => {
                    if (e) return rj(e)
                    builtTo = to
                    rs(to)
                })
            }),
            finalizeState: () => mongo.finalizeRebuildSwap(),
            truncateBlocks: (h) => mongo.truncateBlocks(h),
            resume: () => {},
            clearRollbackMarker: () => Promise.resolve(true)
        })

        assert.notStrictEqual(activeDbDuringRebuild, originalDb,
            'rebuild must run against the temp derived-state DB')
        assert.strictEqual(builtTo, ANCESTOR, 'replay must stop at the common ancestor')
        assert.strictEqual(mongo.originalDb(), originalDb)
        assert.strictEqual(await originalDb.collection('blocks').countDocuments(), ANCESTOR + 1)
        const orphan = await originalDb.collection('blocks').findOne({ _id: FORK_HEAD })
        assert.strictEqual(orphan, null)

        const rebuilt = await stateSnapshotOf(global.db)
        assert.strictEqual(rebuilt.headBlock, reference.headBlock)
        assert.strictEqual(rebuilt.accounts[0].balance, reference.accounts[0].balance)
        assert.strictEqual(stateHash(rebuilt), stateHash(reference))
        assert.strictEqual(chain.recentBlocks[chain.recentBlocks.length - 1].hash, 'canon-' + ANCESTOR)
    })

    await test('a subsequent canonical block replays after Mongo rollback', async () => {
        await originalDb.collection('blocks').insertOne(
            canonBlock(ANCESTOR + 1, 'canon-' + ANCESTOR))
        await mongo.resetDerivedState(SNAPSHOT_HEIGHT)
        chain.blocksToRebuild = []
        chain.recentBlocks = []
        const builtTo = await new Promise((rs, rj) => chain.rebuildState(
            SNAPSHOT_HEIGHT + 1, ANCESTOR + 1, (e, to) => e ? rj(e) : rs(to)))
        assert.strictEqual(builtTo, ANCESTOR + 1)
        await mongo.finalizeRebuildSwap()

        const state = await stateSnapshotOf(global.db)
        assert.strictEqual(state.headBlock, ANCESTOR + 1)
        assert.strictEqual(state.accounts[0].balance, 15 + 6)
        assert.strictEqual(chain.recentBlocks[chain.recentBlocks.length - 1].hash, 'canon-6')
        assert.strictEqual((await originalDb.collection('blocks').findOne({ _id: 6 })).hash, 'canon-6')
    })

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
