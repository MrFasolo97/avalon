/* eslint-disable no-magic-numbers */
// Minimal in-memory Mongo-compatible database used by the rollback rebuild
// integration tests. It implements only the collection operations exercised by
// src/stateSnapshot.js, src/mongo.js rollback primitives and chain.batchLoadBlocks.
// No MongoDB daemon is required.

const crypto = require('crypto')

const OPERATORS = ['$lte', '$gte', '$gt', '$lt', '$ne', '$in']

const matches = (doc, query = {}) => Object.keys(query).every(key => {
    const expected = query[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)
        && OPERATORS.some(op => op in expected))
        return OPERATORS.every(op => {
            if (!(op in expected)) return true
            const value = expected[op]
            switch (op) {
            case '$lte': return doc[key] <= value
            case '$gte': return doc[key] >= value
            case '$gt': return doc[key] > value
            case '$lt': return doc[key] < value
            case '$ne': return doc[key] !== value
            case '$in': return value.indexOf(doc[key]) !== -1
            default: return false
            }
        })
    return doc[key] === expected
})

const sortRows = (rows, spec) => {
    if (typeof spec === 'function') return rows.sort(spec)
    for (const key of Object.keys(spec)) {
        const direction = spec[key] === -1 ? -1 : 1
        rows.sort((a, b) => {
            const av = a[key]
            const bv = b[key]
            if (av === bv) return 0
            if (av === undefined) return 1
            if (bv === undefined) return -1
            return (av < bv ? -1 : 1) * direction
        })
    }
    return rows
}

const cursorFor = (rows) => {
    const cursor = {
        sort: (spec) => { sortRows(rows, spec); return cursor },
        limit: (n) => { rows = rows.slice(0, n); return cursor },
        toArray: (cb) => {
            const run = async () => rows.map(row => Object.assign({}, row))
            if (typeof cb === 'function') return run().then(result => cb(null, result), cb)
            return run()
        },
        [Symbol.asyncIterator]: async function* () {
            for (const row of rows) yield Object.assign({}, row)
        }
    }
    return cursor
}

function makeDb(databaseName = 'avalon', registry = null) {
    const cols = {}
    const docs = name => (cols[name] = cols[name] || [])

    const collection = (name) => ({
        find: (query = {}, opts = {}) => {
            let rows = docs(name).filter(doc => matches(doc, query))
            if (opts && opts.sort) sortRows(rows, opts.sort)
            if (opts && Number.isInteger(opts.limit)) rows = rows.slice(0, opts.limit)
            return cursorFor(rows)
        },
        findOne: (query = {}, opts = {}, cb) => {
            if (typeof opts === 'function') {
                cb = opts
                opts = {}
            }
            const run = async () => {
                const rows = docs(name).filter(doc => matches(doc, query))
                if (opts && opts.sort) sortRows(rows, opts.sort)
                return rows.length ? Object.assign({}, rows[0]) : null
            }
            if (typeof cb === 'function') return run().then(result => cb(null, result), cb)
            return run()
        },
        insertOne: async (doc, cb) => {
            const copy = Object.assign({}, doc)
            docs(name).push(copy)
            const result = { acknowledged: true, insertedId: copy._id }
            if (typeof cb === 'function') cb(null, result)
            return result
        },
        insertMany: async (list) => {
            const before = docs(name).length
            for (const doc of list) docs(name).push(Object.assign({}, doc))
            return { acknowledged: true, insertedCount: docs(name).length - before }
        },
        deleteMany: async (query, cb) => {
            const before = docs(name).length
            cols[name] = docs(name).filter(doc => !matches(doc, query))
            const result = { acknowledged: true, deletedCount: before - docs(name).length }
            if (typeof cb === 'function') cb(null, result)
            return result
        },
        deleteOne: async (query) => {
            const index = docs(name).findIndex(doc => matches(doc, query))
            if (index !== -1) docs(name).splice(index, 1)
            return { acknowledged: true, deletedCount: index === -1 ? 0 : 1 }
        },
        replaceOne: async (query, doc, opts = {}) => {
            const index = docs(name).findIndex(row => matches(row, query))
            if (index === -1) {
                if (!opts.upsert) return { acknowledged: true, matchedCount: 0 }
                docs(name).push(Object.assign({}, doc))
                return { acknowledged: true, matchedCount: 0, upsertedCount: 1 }
            }
            docs(name)[index] = Object.assign({}, doc)
            return { acknowledged: true, matchedCount: 1 }
        },
        updateOne: async (query, update = {}, opts = {}, cb) => {
            if (typeof opts === 'function') {
                cb = opts
                opts = {}
            }
            let row = docs(name).find(doc => matches(doc, query))
            if (!row) {
                if (!opts.upsert) {
                    const result = { acknowledged: true, matchedCount: 0 }
                    if (typeof cb === 'function') cb(null, result)
                    return result
                }
                row = Object.assign({}, query)
                docs(name).push(row)
            }
            for (const field of Object.keys(update.$set || {})) row[field] = update.$set[field]
            for (const field of Object.keys(update.$inc || {}))
                row[field] = (row[field] || 0) + update.$inc[field]
            const result = { acknowledged: true, matchedCount: 1 }
            if (typeof cb === 'function') cb(null, result)
            return result
        },
        countDocuments: async () => docs(name).length,
        // Minimal aggregation support: the snapshot code only uses $match + $out.
        aggregate: async (pipeline = []) => {
            let rows = docs(name).map(doc => Object.assign({}, doc))
            let out = null
            for (const stage of pipeline) {
                if (stage.$match) rows = rows.filter(doc => matches(doc, stage.$match))
                if (stage.$out) out = stage.$out
            }
            if (out && typeof global !== 'undefined' && global.fakeMongoOutHook)
                await global.fakeMongoOutHook(name, out, rows)
            if (out) {
                const clientRegistry = registry || dbObject._registry
                const targetDb = !out.db || out.db === databaseName
                    ? dbObject
                    : (clientRegistry
                        ? (clientRegistry[out.db] = clientRegistry[out.db] || makeDb(out.db, clientRegistry))
                        : null)
                if (!targetDb) throw new Error('cross-db $out requires makeClient registry')
                targetDb.collection(out.coll)._replaceAll(rows)
            }
            return { toArray: async () => [] }
        },
        _replaceAll: async (rows) => {
            cols[name] = rows.map(doc => Object.assign({}, doc))
            return rows.length
        },
        createIndex: async () => 'idx',
        rename: async (target) => {
            cols[target] = docs(name).map(doc => Object.assign({}, doc))
            delete cols[name]
            return true
        },
        drop: async () => {
            delete cols[name]
            return true
        }
    })

    const dbObject = {
        databaseName,
        collection,
        createCollection: async (name) => { docs(name); return true },
        listCollections: (query = {}) => {
            const rows = Object.keys(cols)
                .filter(name => !query.name || name === query.name)
                .map(name => ({ name }))
            return {
                hasNext: async () => rows.length > 0,
                toArray: async () => rows.map(row => Object.assign({}, row))
            }
        },
        dropDatabase: async () => {
            for (const name of Object.keys(cols)) delete cols[name]
            return true
        },
        _collections: cols
    }
    return dbObject
}

const makeClient = (dbs = {}) => {
    // Databases created outside makeClient (the common test setup) need the
    // same registry so server-side `$out` can resolve a cross-DB target.
    for (const name of Object.keys(dbs)) dbs[name]._registry = dbs
    return { db: (name) => (dbs[name] = dbs[name] || makeDb(name, dbs)) }
}

async function stateSnapshotOf(database) {
    const accounts = await database.collection('accounts').find({}, { sort: { name: 1 } }).toArray()
    const state = await database.collection('state').findOne({ _id: 0 })
    return { accounts, headBlock: state ? state.headBlock : null }
}

const stateHash = state => crypto.createHash('sha256')
    .update(JSON.stringify(state)).digest('hex')

module.exports = { makeDb, makeClient, stateSnapshotOf, stateHash }
