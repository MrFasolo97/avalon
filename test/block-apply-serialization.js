/* eslint-disable no-magic-numbers */
// == H2: serialized block application + persistence error propagation ==
// node test/block-apply-serialization.js
//
// Two regressions are pinned here:
//  1. validateAndAddBlock used to have no lock. P2P recovery, the pending-block
//     timer, local finalisation and force-finalize can all submit the same
//     height concurrently; two calls could validate against the same head and
//     both persist it. The whole accept path now runs through a FIFO queue.
//  2. addBlock's error was discarded by validateAndAddBlock, which always
//     reported success. A failed block/state write therefore cleared P2P and
//     consensus buffers as if the block had been applied.

const assert = require('assert')

let passed = 0
let failed = 0

async function test(name, fn) {
    try {
        await fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        failed++
    }
}

async function main() {
    // ---------------------------------------------------------------------------
    // 1. The serial executor itself (no chain globals involved).
    // ---------------------------------------------------------------------------
    const SerialQueue = require('../src/serialQueue')

    console.log('=== H2: block application serialization ===\n')

    await test('SerialQueue runs concurrent tasks one at a time in FIFO order', async () => {
        const q = new SerialQueue()
        let active = 0
        let maxActive = 0
        const order = []
        const tasks = []
        for (let i = 0; i < 5; i++) {
            const delay = 5
            tasks.push(q.run(async () => {
                active++
                maxActive = Math.max(maxActive, active)
                await new Promise(r => setTimeout(r, delay))
                order.push(i)
                active--
            }))
        }
        await Promise.all(tasks)
        assert.strictEqual(maxActive, 1, 'no two tasks may overlap')
        assert.deepStrictEqual(order, [0, 1, 2, 3, 4])
        assert.strictEqual(q.pending, 0)
    })

    await test('SerialQueue propagates a task error and still runs later tasks', async () => {
        const q = new SerialQueue()
        const first = q.run(async () => { throw new Error('save failed') })
        const second = q.run(async () => 'ok')
        let message = null
        try { await first } catch (e) { message = e.message }
        assert.strictEqual(message, 'save failed')
        assert.strictEqual(await second, 'ok')
        assert.strictEqual(q.pending, 0, 'a rejection must not poison the queue')
    })

    // ---------------------------------------------------------------------------
    // 2. chain-level: real addBlock / validateAndAddBlock with mocked persistence.
    // ---------------------------------------------------------------------------
    global.logr = { info(){}, warn(){}, debug(){}, error(){}, trace(){}, cons(){}, fatal(){}, econ(){} }
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        leaders: 5,
        blockTime: 3000,
        maxDrift: 5000,
        ecoBlocks: 1000,
        ecoBlocksIncreasesSoon: false
    }

    function stub(rel, exports) {
        require.cache[require.resolve(rel)] = { exports }
    }
    stub('../src/logger', global.logr)
    stub('../src/config.js', { read: () => ({}) })
    stub('../src/blocks', { isOpen: false, height: 0, read: () => null, appendBlock(){} })
    stub('../src/dao', { nextBlock(){}, resetID(){} })
    stub('../src/daoMaster', { nextBlock(){}, resetID(){} })
    stub('../src/transaction.js', { removeFromPool(){}, eventConfirmation: { emit(){} } })
    stub('../src/notifications.js', { processBlock(){} })
    stub('../src/txHistory', { processBlock(){} })
    stub('../src/leaderHealth', {
        processBlock(){},
        checkpointCollection: 'jailCheckpoint',
        persistCheckpoint: () => Promise.resolve(false),
        loadCheckpoint: () => Promise.resolve(null)
    })

    let insertFails = false
    let inserts = 0
    let flushFails = false
    let flushCalls = 0
    let clearCalls = 0

    global.db = {
        collection(name) {
            if (name === 'blocks')
                return {
                    findOne: async () => null,
                    insertOne: async () => {
                        inserts++
                        if (insertFails) throw new Error('disk full')
                    }
                }
            return { updateOne: (q, u, o, cb) => { if (cb) cb(null) } }
        }
    }
    global.eco = { cleanHistory(){}, appendHistory(){}, nextBlock(){} }
    global.leaderStats = { processBlock(){} }
    global.p2p = { recovering: true, broadcastBlock(){}, addRecursive(){} }
    global.cache = {
        changes: [], inserts: [],
        writeToDisk(rebuild, cb) {
            flushCalls++
            if (flushFails) cb(new Error('mongo down'))
            else cb(null)
        },
        clear() { clearCalls++ },
        rollback() {}
    }

    const chain = require('../src/chain')
    const realAddBlock = chain.addBlock

    // Avoid timers and hardfork bookkeeping in this unit test.
    chain.applyHardforkPostBlock = () => {}
    chain.minerWorker = () => {}
    chain.output = () => {}
    chain.isValidNewBlock = (block, revalidate, checkTs, cb) => cb(true)
    chain.executeBlockTransactions = (block, revalidate, cb) => cb(block.txs || [], block.dist || 0, block.burn || 0)

    function reset(opts = {}) {
        chain.recentBlocks = [{ _id: 0, hash: 'genesis' }]
        chain.recentTxs = {}
        chain.applyQueue = new SerialQueue()
        insertFails = !!opts.insertFails
        flushFails = !!opts.flushFails
        inserts = 0
        flushCalls = 0
        clearCalls = 0
    }

    function apply(block) {
        return new Promise(resolve => chain.validateAndAddBlock(block, true, (err, applied) => resolve({ err, applied })))
    }

    function block(id, hash) {
        return { _id: id, hash: hash || ('h' + id), txs: [], dist: 0, burn: 0, timestamp: Date.now() }
    }

    await test('concurrent validations are serialized and persist in submission order', async () => {
        let active = 0
        let maxActive = 0
        const order = []
        chain.addBlock = async (b, cb) => {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise(r => setTimeout(r, 5))
            order.push(b._id)
            active--
            cb(null, b)
        }
        reset()
        const results = await Promise.all([1, 2, 3, 4].map(i => apply(block(i))))
        assert.strictEqual(maxActive, 1, 'addBlock must never run concurrently')
        assert.deepStrictEqual(order, [1, 2, 3, 4])
        assert.ok(results.every(r => !r.err), 'all queued blocks succeed')
        assert.strictEqual(chain.applyQueue.pending, 0)
    })

    await test('the same block submitted twice is persisted only once', async () => {
        chain.addBlock = realAddBlock // use the real implementation
        reset()
        const b = block(1)
        const results = await Promise.all([apply(b), apply(b)])
        assert.ok(results.every(r => !r.err))
        assert.strictEqual(inserts, 1, 'duplicate submission must not insert twice')
        assert.strictEqual(chain.recentBlocks.filter(x => x._id === 1).length, 1)
        assert.strictEqual(flushCalls, 1, 'the duplicate is a no-op before the state flush')
    })

    await test('block save failure is propagated and leaves head/state unchanged', async () => {
        chain.addBlock = realAddBlock
        reset({ insertFails: true })
        const r = await apply(block(1))
        assert.ok(r.err instanceof Error, 'caller receives the persistence error')
        assert.strictEqual(r.err.message, 'disk full')
        assert.strictEqual(inserts, 1)
        assert.strictEqual(chain.recentBlocks.length, 1, 'head did not advance')
        assert.strictEqual(flushCalls, 0, 'no state flush after a failed block write')
        assert.strictEqual(clearCalls, 0, 'pending cache changes are kept')

        // The failed task must not block the next block.
        insertFails = false
        const next = await apply(block(1))
        assert.ok(!next.err, 'queue continues after a failed block')
        assert.strictEqual(chain.recentBlocks.length, 2)
    })

    await test('state flush failure is propagated and does not discard cache changes', async () => {
        chain.addBlock = realAddBlock
        reset({ flushFails: true })
        const r = await apply(block(1))
        assert.ok(r.err instanceof Error)
        assert.strictEqual(r.err.message, 'mongo down')
        assert.strictEqual(flushCalls, 1)
        assert.strictEqual(clearCalls, 0, 'cache must not be cleared when the flush failed')
        assert.strictEqual(inserts, 1)
    })

    await test('ProcessingQueue forwards task errors to its onError handler', async () => {
        const ProcessingQueue = require('../src/processingQueue')
        const q = new ProcessingQueue()
        const errors = []
        await new Promise(resolve => {
            q.push(done => done(new Error('write failed')), err => errors.push(err.message))
            setTimeout(resolve, 10)
        })
        assert.deepStrictEqual(errors, ['write failed'])
        assert.strictEqual(q.processing, false, 'queue recovers after an error')
    })

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
