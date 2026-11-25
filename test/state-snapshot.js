/* eslint-disable no-magic-numbers */
// == Bounded state snapshots used by proof-gated rollback ==
// node test/state-snapshot.js
//
// Verifies that a rollback can restore derived state from the newest snapshot
// at/below the common ancestor, and fails closed when none exists. No MongoDB
// is needed: the collection API is stubbed in memory.

const assert = require('assert')
const stateSnapshot = require('../src/stateSnapshot')

let passed = 0
let failed = 0
function test(name, fn) {
    return Promise.resolve().then(fn).then(() => {
        console.log('  PASS: ' + name)
        passed++
    }).catch(e => {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        failed++
    })
}

const collections = {}
const docs = (name) => (collections[name] = collections[name] || [])
const matches = (doc, query) => Object.keys(query || {}).every(k => {
    const expected = query[k]
    if (expected && typeof expected === 'object' && '$lte' in expected)
        return doc[k] <= expected.$lte
    return doc[k] === expected
})

const collection = (name) => ({
    findOne: async (query) => docs(name).find(d => matches(d, query)) || null,
    find: (query, opts) => {
        let rows = docs(name).filter(d => matches(d, query))
        const applySort = (sort) => {
            if (sort && sort.height !== undefined)
                rows = rows.slice().sort((a, b) => (b.height || 0) - (a.height || 0))
            else if (sort && typeof sort === 'function') rows = rows.sort(sort)
            return cursor
        }
        const applyLimit = (n) => { rows = rows.slice(0, n); return cursor }
        const cursor = {
            sort: applySort,
            limit: applyLimit,
            toArray: async () => rows,
            [Symbol.asyncIterator]: async function* () {
                for (const r of rows) yield r
            }
        }
        if (opts && opts.sort) applySort(opts.sort)
        if (opts && opts.limit) applyLimit(opts.limit)
        return cursor
    },
    deleteMany: async () => { collections[name] = []; return { deletedCount: 1 } },
    insertMany: async (rows) => { docs(name).push(...rows.map(r => Object.assign({}, r))) },
    replaceOne: async (query, doc) => {
        const idx = docs(name).findIndex(d => matches(d, query))
        if (idx === -1) docs(name).push(Object.assign({}, doc))
        else docs(name)[idx] = Object.assign({}, doc)
    },
    updateOne: async (query, update) => {
        const row = docs(name).find(d => matches(d, query))
        if (row) Object.assign(row, update.$set || {})
    },
    deleteOne: async (query) => {
        const idx = docs(name).findIndex(d => matches(d, query))
        if (idx !== -1) docs(name).splice(idx, 1)
    },
    countDocuments: async () => docs(name).length
})

global.db = {
    collection,
    listCollections: (q) => ({
        hasNext: async () => !!(q && q.name && collections[q.name])
    })
}

async function main() {
    console.log('=== State snapshots for automatic rollback ===\n')
    const prevAuto = process.env.AUTO_ROLLBACK
    process.env.AUTO_ROLLBACK = '1'

    try {
        await test('restores the newest snapshot at or below the ancestor', async () => {
            for (const k of Object.keys(collections)) delete collections[k]
            docs('accounts').push({ name: 'alice', balance: 10 })
            docs('state').push({ _id: 0, headBlock: 100, gov: 'old' })
            await stateSnapshot.save(100)

            docs('accounts')[0].balance = 99
            docs('state')[0].headBlock = 105
            docs('state')[0].gov = 'new'
            await stateSnapshot.save(105)

            docs('accounts')[0].balance = 123
            const restored = await stateSnapshot.restore(104)
            assert.strictEqual(restored, 100)
            assert.strictEqual(docs('accounts')[0].balance, 10)
            assert.strictEqual(docs('state')[0].headBlock, 100)
            assert.strictEqual(docs('state')[0].gov, 'old')
        })

        await test('fails closed when no snapshot is old enough', async () => {
            await assert.rejects(() => stateSnapshot.restore(50), /no state snapshot/)
            assert.strictEqual(docs('accounts')[0].balance, 10)
        })

        await test('prunes snapshots beyond STATE_SNAPSHOT_KEEP', async () => {
            const previous = process.env.STATE_SNAPSHOT_KEEP
            process.env.STATE_SNAPSHOT_KEEP = '2'
            try {
                await stateSnapshot.save(110)
                await stateSnapshot.save(115)
                const remaining = docs('stateSnapshots').map(s => s.height).sort((a, b) => a - b)
                assert.deepStrictEqual(remaining, [105, 110, 115].slice(-2))
            } finally {
                if (previous === undefined) delete process.env.STATE_SNAPSHOT_KEEP
                else process.env.STATE_SNAPSHOT_KEEP = previous
            }
        })

        await test('skips save/ensure/maybeSave when AUTO_ROLLBACK is disabled', async () => {
            for (const k of Object.keys(collections)) delete collections[k]
            docs('accounts').push({ name: 'alice', balance: 1 })
            docs('state').push({ _id: 0, headBlock: 10 })
            const prev = process.env.AUTO_ROLLBACK
            process.env.AUTO_ROLLBACK = '0'
            try {
                assert.strictEqual(await stateSnapshot.save(10), false)
                assert.strictEqual(await stateSnapshot.ensure(10), false)
                assert.strictEqual(await stateSnapshot.maybeSave(10000), false)
                assert.strictEqual(docs('stateSnapshots').length, 0)
            } finally {
                if (prev === undefined) delete process.env.AUTO_ROLLBACK
                else process.env.AUTO_ROLLBACK = prev
            }
        })

        await test('preflight rejects incomplete snapshot metadata/count mismatch', async () => {
            for (const k of Object.keys(collections)) delete collections[k]
            docs('accounts').push({ name: 'alice', balance: 10 })
            docs('state').push({ _id: 0, headBlock: 50 })
            await stateSnapshot.save(50)
            // Corrupt count metadata
            docs('stateSnapshots')[0].collectionCounts.accounts = 999
            await assert.rejects(() => stateSnapshot.preflightAtOrBelow(50), /integrity check failed/)
        })

        await test('streamed copy handles many docs in batches', async () => {
            for (const k of Object.keys(collections)) delete collections[k]
            for (let i = 0; i < 2505; i++) docs('accounts').push({ _id: i, balance: i })
            docs('state').push({ _id: 0, headBlock: 200 })
            await stateSnapshot.save(200)
            docs('accounts').length = 0
            const restored = await stateSnapshot.restore(200)
            assert.strictEqual(restored, 200)
            assert.strictEqual(docs('accounts').length, 2505)
            assert.strictEqual(docs('accounts')[2504].balance, 2504)
        })

    } finally {
        if (prevAuto === undefined) delete process.env.AUTO_ROLLBACK
        else process.env.AUTO_ROLLBACK = prevAuto
    }

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
