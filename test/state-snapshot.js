/* eslint-disable no-magic-numbers */
// == Bounded state snapshots used by proof-gated rollback ==
// node test/state-snapshot.js
//
// Verifies height-consistent, server-side ($out) snapshots, restore, preflight
// integrity checks and failure handling. No MongoDB is needed: the collection
// API is stubbed in memory, including $out and its atomic temp+rename fallback.

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

const outCalls = []
global.fakeMongoOutHook = null

const cursorFor = (rows) => {
    const cursor = {
        sort: (spec) => {
            if (spec && spec.height !== undefined)
                rows = rows.slice().sort((a, b) => (b.height || 0) - (a.height || 0))
            return cursor
        },
        limit: (n) => { rows = rows.slice(0, n); return cursor },
        toArray: async () => rows,
        [Symbol.asyncIterator]: async function* () {
            for (const r of rows) yield r
        }
    }
    return cursor
}

const collection = (name) => ({
    findOne: async (query) => docs(name).find(d => matches(d, query)) || null,
    find: (query, opts) => {
        let rows = docs(name).filter(d => matches(d, query))
        const cursor = cursorFor(rows)
        if (opts && opts.sort) cursor.sort(opts.sort)
        if (opts && opts.limit) cursor.limit(opts.limit)
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
    countDocuments: async () => docs(name).length,
    aggregate: async (pipeline = []) => {
        let rows = docs(name).map(row => Object.assign({}, row))
        let out = null
        for (const stage of pipeline) {
            if (stage.$match) rows = rows.filter(doc => matches(doc, stage.$match))
            if (stage.$out) out = stage.$out
        }
        if (out) {
            outCalls.push({ source: name, db: out.db, coll: out.coll, count: rows.length })
            if (global.fakeMongoOutHook) await global.fakeMongoOutHook(name, rows)
            if (!out.db || out.db === 'avalon') collections[out.coll] = rows
            else throw new Error('unexpected cross-database snapshot target: ' + out.db)
        }
        return { toArray: async () => [] }
    },
    rename: async (target) => {
        collections[target] = docs(name).map(row => Object.assign({}, row))
        delete collections[name]
        return true
    },
    drop: async () => { delete collections[name]; return true }
})

global.db = {
    databaseName: 'avalon',
    collection,
    createCollection: async (name) => { docs(name); return true },
    listCollections: (q) => ({
        hasNext: async () => !!(q && q.name && collections[q.name])
    })
}

const reset = () => {
    for (const k of Object.keys(collections)) delete collections[k]
    outCalls.length = 0
    global.fakeMongoOutHook = null
}

async function main() {
    console.log('=== State snapshots for automatic rollback ===\n')
    const prevAuto = process.env.AUTO_ROLLBACK
    process.env.AUTO_ROLLBACK = '1'

    try {
        await test('server-side $out snapshot is height-consistent and integrity-checked', async () => {
            reset()
            docs('accounts').push({ name: 'alice', balance: 10 })
            docs('state').push({ _id: 0, headBlock: 100, gov: 'old' })
            assert.strictEqual(await stateSnapshot.save(100), true)
            assert.strictEqual(outCalls.length, stateSnapshot.collections.length)
            assert.ok(outCalls.every(c => c.db === 'avalon'))
            assert.strictEqual(docs('stateSnapshots')[0].collectionCounts.accounts, 1)
            assert.strictEqual(docs('stateSnapshots')[0].height, 100)
            assert.strictEqual(await stateSnapshot.preflightAtOrBelow(100), 100)

            docs('accounts')[0].balance = 99
            docs('state')[0].headBlock = 105
            docs('state')[0].gov = 'new'
            await stateSnapshot.save(105)
            assert.strictEqual((await docs('stateSnapshots').find(s => s.height === 105)).height, 105)
            const restored = await stateSnapshot.restore(104)
            assert.strictEqual(restored, 100)
            assert.strictEqual(docs('accounts')[0].balance, 10)
            assert.strictEqual(docs('state')[0].headBlock, 100)
            assert.strictEqual(docs('state')[0].gov, 'old')
        })

        await test('refuses a snapshot when the persisted state head is at another height', async () => {
            reset()
            docs('accounts').push({ name: 'alice', balance: 10 })
            docs('state').push({ _id: 0, headBlock: 100 })
            await assert.rejects(() => stateSnapshot.save(105), /state head is #100/)
            assert.strictEqual(docs('stateSnapshots').length, 0)
        })

        await test('fails closed on mid-copy failure without touching live state', async () => {
            reset()
            docs('accounts').push({ name: 'alice', balance: 10 })
            docs('state').push({ _id: 0, headBlock: 50 })
            global.fakeMongoOutHook = async (name) => {
                if (name === 'txs') throw new Error('simulated mid-copy failure')
            }
            await assert.rejects(() => stateSnapshot.save(50), /simulated mid-copy failure/)
            assert.strictEqual(docs('stateSnapshots').length, 0)
            assert.strictEqual(docs('stateSnapshot_50_accounts').length, 0)
            assert.strictEqual(docs('accounts')[0].balance, 10)
            assert.strictEqual(docs('state')[0].headBlock, 50)
            global.fakeMongoOutHook = null
            assert.strictEqual(await stateSnapshot.save(50), true)
            assert.strictEqual(await stateSnapshot.preflightAtOrBelow(50), 50)
        })

        await test('falls back to atomic temp+rename when $out is unsupported', async () => {
            reset()
            for (let i = 0; i < 1205; i++) docs('accounts').push({ _id: i, balance: i })
            docs('state').push({ _id: 0, headBlock: 200 })
            let first = true
            global.fakeMongoOutHook = async (name) => {
                if (name === 'accounts' && first) {
                    first = false
                    throw new Error('Unrecognized pipeline stage name: \'$out\'')
                }
            }
            assert.strictEqual(await stateSnapshot.save(200), true)
            assert.strictEqual(docs('stateSnapshots')[0].collectionCounts.accounts, 1205)
            global.fakeMongoOutHook = null
            docs('accounts').length = 0
            const restored = await stateSnapshot.restore(200)
            assert.strictEqual(restored, 200)
            assert.strictEqual(docs('accounts').length, 1205)
            assert.strictEqual(docs('accounts')[1204].balance, 1204)
            const leftovers = Object.keys(collections).filter(n => n.indexOf('_copy_tmp_') !== -1)
            assert.strictEqual(leftovers.length, 0)
        })

        await test('fails closed when no snapshot is old enough', async () => {
            reset()
            docs('accounts').push({ name: 'alice', balance: 10 })
            docs('state').push({ _id: 0, headBlock: 100 })
            await stateSnapshot.save(100)
            await assert.rejects(() => stateSnapshot.restore(50), /no state snapshot/)
            assert.strictEqual(docs('accounts')[0].balance, 10)
        })

        await test('prunes snapshots beyond STATE_SNAPSHOT_KEEP', async () => {
            const previous = process.env.STATE_SNAPSHOT_KEEP
            process.env.STATE_SNAPSHOT_KEEP = '2'
            try {
                docs('state')[0].headBlock = 110
                await stateSnapshot.save(110)
                docs('state')[0].headBlock = 115
                await stateSnapshot.save(115)
                const remaining = docs('stateSnapshots').map(s => s.height).sort((a, b) => a - b)
                assert.deepStrictEqual(remaining, [105, 110, 115].slice(-2))
            } finally {
                if (previous === undefined) delete process.env.STATE_SNAPSHOT_KEEP
                else process.env.STATE_SNAPSHOT_KEEP = previous
            }
        })

        await test('skips save/ensure/maybeSave when AUTO_ROLLBACK is disabled', async () => {
            reset()
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
            reset()
            docs('accounts').push({ name: 'alice', balance: 10 })
            docs('state').push({ _id: 0, headBlock: 50 })
            await stateSnapshot.save(50)
            docs('stateSnapshots')[0].collectionCounts.accounts = 999
            await assert.rejects(() => stateSnapshot.preflightAtOrBelow(50), /integrity check failed/)
        })

        await test('warns at startup when AUTO_ROLLBACK=1 is set on a leader', async () => {
            reset()
            const prevOwner = process.env.NODE_OWNER
            const prevPriv = process.env.NODE_OWNER_PRIV
            const prevLogr = global.logr
            const prevChain = global.chain
            const warnings = []
            global.logr = { warn: (msg) => warnings.push(msg) }
            process.env.NODE_OWNER = 'leader1'
            process.env.NODE_OWNER_PRIV = 'signing-key'
            global.chain = { schedule: { shuffle: [{ name: 'leader1' }] } }
            try {
                assert.strictEqual(stateSnapshot.warnIfLeaderNode(), true)
                assert.strictEqual(warnings.length, 1)
                assert.match(warnings[0], /AUTO_ROLLBACK=1/)
                assert.match(warnings[0], /non-leader\/sync nodes only/)
                process.env.NODE_OWNER_PRIV = ''
                assert.strictEqual(stateSnapshot.warnIfLeaderNode(), false)
            } finally {
                if (prevOwner === undefined) delete process.env.NODE_OWNER
                else process.env.NODE_OWNER = prevOwner
                if (prevPriv === undefined) delete process.env.NODE_OWNER_PRIV
                else process.env.NODE_OWNER_PRIV = prevPriv
                if (prevLogr === undefined) delete global.logr
                else global.logr = prevLogr
                if (prevChain === undefined) delete global.chain
                else global.chain = prevChain
            }
        })

    } finally {
        delete global.fakeMongoOutHook
        if (prevAuto === undefined) delete process.env.AUTO_ROLLBACK
        else process.env.AUTO_ROLLBACK = prevAuto
    }

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
