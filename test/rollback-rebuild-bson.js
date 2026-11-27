/* eslint-disable no-magic-numbers */
// == R7 integration: rollback rebuilds state from the BSON block store ==
// node test/rollback-rebuild-bson.js
//
// REAL chain.rebuildState / chain.batchLoadBlocks (nothing stubs the rebuild).
// A canonical chain is stored in blocks.bson, a forked node applies orphaned
// blocks past the common ancestor, then rollback restores a state snapshot,
// replays ONLY the canonical prefix, swaps it in and truncates the fork. The
// resulting state hash/balances/head must equal a clean reference node that
// never forked, and the next canonical block must replay cleanly.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeDb, makeClient, stateSnapshotOf, stateHash } = require('./lib/fakeMongoDb')

process.env.AUTO_ROLLBACK = '1'
process.env.REBUILD_NO_VALIDATE = '1'
delete process.env.NOTIFICATIONS
process.env.BLOCKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-r7-bson-'))

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

const blocks = require('../src/blocks')
const mongo = require('../src/mongo')
mongo.dbName = 'avalon'
mongo.db = originalDb
mongo.client = makeClient({ avalon: originalDb })

const stateSnapshot = require('../src/stateSnapshot')
const divergence = require('../src/divergence')
const chain = require('../src/chain')
global.chain = chain

const dao = require('../src/dao')
const daoMaster = require('../src/daoMaster')
const eco = require('../src/economics')
const notifications = require('../src/notifications')
const leaderHealth = require('../src/leaderHealth')
const leaderStats = require('../src/leaderStats')

// Only the transaction execution side effects are supplied by the harness.
// The replay loop, block reads, batching, bounds and swap are all real code.
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

const applyDeltas = async (database, blocksToApply) => {
    for (const block of blocksToApply)
        for (const tx of block.txs) {
            const account = await database.collection('accounts').findOne({ name: 'alice' })
            await database.collection('accounts').updateOne({ name: 'alice' },
                { $set: { balance: account.balance + tx.data.delta } })
        }
    await database.collection('state').updateOne({ _id: 0 },
        { $set: { headBlock: blocksToApply[blocksToApply.length - 1]._id } }, { upsert: true })
}

const initDb = async (database) => {
    await database.collection('accounts').insertOne({ name: 'alice', balance: 0 })
    await database.collection('state').insertOne({ _id: 0, headBlock: 0 })
}

const rebuild = (database, from, end) => {
    const previousDb = global.db
    global.db = database
    chain.blocksToRebuild = []
    chain.recentBlocks = []
    return new Promise((rs, rj) => chain.rebuildState(from, end, (e, builtTo) => {
        if (e) return rj(e)
        rs(builtTo)
    })).finally(() => { global.db = previousDb })
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
    console.log('=== R7: rollback state rebuild (BSON block store) ===\n')

    await test('rollback rebuild stops at the ancestor and matches a clean reference node', async () => {
        // Canonical prefix + orphaned fork tail in the real BSON block store.
        blocks.touch()
        blocks.fd = fs.openSync(path.join(process.env.BLOCKS_DIR, 'blocks.bson'), 'a+')
        blocks.fdIndex = fs.openSync(path.join(process.env.BLOCKS_DIR, 'blocks.index'), 'a+')
        blocks.bsonSize = 0n
        blocks.height = -1
        blocks.isOpen = true
        let phash = '0'
        for (let h = 0; h <= ANCESTOR; h++) {
            const block = canonBlock(h, phash)
            blocks.appendBlock(block)
            phash = block.hash
        }
        for (let h = ANCESTOR + 1; h <= FORK_HEAD; h++) {
            const block = forkBlock(h, phash)
            blocks.appendBlock(block)
            phash = block.hash
        }
        assert.strictEqual(blocks.height, FORK_HEAD)

        // Local derived state: snapshot BELOW the ancestor (so replay has to
        // cross it), the canonical prefix up to the ancestor, then the fork.
        await initDb(originalDb)
        global.db = originalDb
        const prefix = [canonBlock(0, '0')].concat(Array.from({ length: SNAPSHOT_HEIGHT },
            (_, i) => canonBlock(i + 1, 'canon-' + i)))
        await applyDeltas(originalDb, prefix)
        await stateSnapshot.save(SNAPSHOT_HEIGHT)
        await applyDeltas(originalDb, Array.from({ length: ANCESTOR - SNAPSHOT_HEIGHT },
            (_, i) => canonBlock(SNAPSHOT_HEIGHT + i + 1, 'canon-' + (SNAPSHOT_HEIGHT + i))))
        await applyDeltas(originalDb,
            Array.from({ length: FORK_HEAD - ANCESTOR }, (_, i) => forkBlock(ANCESTOR + i + 1, 'x')))
        const diverged = await stateSnapshotOf(originalDb)
        assert.strictEqual(diverged.headBlock, FORK_HEAD)
        assert.strictEqual(diverged.accounts[0].balance, 15 + 106 + 107 + 108)

        // Clean reference node: never saw the fork, replays the same canonical
        // prefix with the same real rebuild machinery.
        const referenceDb = makeDb()
        await initDb(referenceDb)
        await applyDeltas(referenceDb, prefix)
        const referenceBuiltTo = await rebuild(referenceDb, SNAPSHOT_HEIGHT + 1, ANCESTOR)
        assert.strictEqual(referenceBuiltTo, ANCESTOR)
        const reference = await stateSnapshotOf(referenceDb)
        assert.strictEqual(reference.headBlock, ANCESTOR)
        assert.strictEqual(reference.accounts[0].balance, 15)

        // Rollback with real snapshot restore, real rebuild and real truncation.
        global.db = originalDb
        mongo.db = originalDb
        mongo._rebuildOriginalDb = null
        mongo._rebuildContext = null
        let snapshotHeight = null
        let builtTo = null
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
                const from = Math.min(snapshotHeight + 1, endHeight + 1)
                chain.rebuildState(from, endHeight, (e, to) => {
                    if (e) return rj(e)
                    builtTo = to
                    rs(to)
                })
            }),
            finalizeState: () => mongo.finalizeRebuildSwap(),
            truncateBlocks: (h) => blocks.truncate(h),
            resume: () => {},
            clearRollbackMarker: () => Promise.resolve(true)
        })

        assert.strictEqual(builtTo, ANCESTOR, 'replay must stop exactly at the common ancestor')
        assert.strictEqual(blocks.height, ANCESTOR, 'orphaned BSON blocks must be truncated')
        assert.throws(() => blocks.read(ANCESTOR + 1), /Block not found/)
        assert.strictEqual(blocks.read(ANCESTOR).hash, 'canon-' + ANCESTOR)
        const rebuilt = await stateSnapshotOf(global.db)
        assert.strictEqual(rebuilt.headBlock, reference.headBlock)
        assert.strictEqual(rebuilt.accounts[0].balance, reference.accounts[0].balance)
        assert.strictEqual(stateHash(rebuilt), stateHash(reference))
        assert.strictEqual(chain.recentBlocks[chain.recentBlocks.length - 1].hash, 'canon-' + ANCESTOR)
    })

    await test('a subsequent canonical block replays after rollback without divergence', async () => {
        const next = canonBlock(ANCESTOR + 1, 'canon-' + ANCESTOR)
        blocks.appendBlock(next)

        // Fresh temp state from the snapshot, then forward replay to block #6.
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
        assert.strictEqual(blocks.lastBlock().hash, 'canon-6')
    })

    blocks.close()
    fs.rmSync(process.env.BLOCKS_DIR, { recursive: true, force: true })
    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
