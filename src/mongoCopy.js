// == Server-side collection copy for state snapshots (R8) ==
//
// Copying every document through a Node.js cursor used to pin a block-producing
// leader for minutes. MongoDB can do the whole copy server-side with an
// aggregation `$out` stage: it atomically replaces the target collection and no
// document is ever materialised in the Node heap. Server 6.x (testnet and
// production) supports `$out`, including cross-database targets; the driver is
// mongodb@4.17.2.
//
// If a server rejects `$out`, fall back to a bounded batched copy into a
// temporary collection followed by a server-side rename. The rename is atomic,
// so readers never observe a half-written snapshot.

const BATCH_SIZE = 1000

const warn = (msg) => {
    if (typeof logr !== 'undefined' && logr && typeof logr.warn === 'function') logr.warn(msg)
}

const unsupportedOut = (e) => {
    if (!e) return false
    if (e.code === 40324 || e.codeName === 'UnrecognizedPipelineStageName') return true
    const msg = String(e.message || e)
    return msg.indexOf('$out') !== -1 && /unrecognized|unsupported|not supported/i.test(msg)
}

const targetSpec = (db, coll) => {
    const out = { coll }
    if (db && db.databaseName) out.db = db.databaseName
    return out
}

const fallbackCopy = async (sourceDb, sourceName, targetDb, targetName) => {
    const tempName = targetName + '_copy_tmp_' + process.pid + '_' + Date.now()
    const staging = targetDb.collection(tempName)
    try {
        await staging.deleteMany({})
        const cursor = sourceDb.collection(sourceName).find({}, { batchSize: BATCH_SIZE })
        let batch = []
        const flush = async () => {
            if (batch.length === 0) return
            await staging.insertMany(batch, { ordered: true })
            batch = []
        }
        if (cursor && typeof cursor[Symbol.asyncIterator] === 'function')
            for await (const doc of cursor) {
                batch.push(doc)
                if (batch.length >= BATCH_SIZE) await flush()
            }
        else {
            const rows = cursor && typeof cursor.toArray === 'function' ? await cursor.toArray() : []
            for (const doc of rows) {
                batch.push(doc)
                if (batch.length >= BATCH_SIZE) await flush()
            }
        }
        await flush()
        const exists = await targetDb.listCollections({ name: tempName }).hasNext()
        if (!exists && targetDb.createCollection) await targetDb.createCollection(tempName)
        await staging.rename(targetName, { dropTarget: true })
        return await targetDb.collection(targetName).countDocuments({})
    } catch (e) {
        try { await staging.drop() } catch (ignored) { void ignored }
        throw e
    }
}

const mongoCopy = {
    BATCH_SIZE,

    // Copy sourceDb[sourceName] into targetDb[targetName], returning the number
    // of documents written. The caller uses that count for snapshot integrity.
    copy: async (sourceDb, sourceName, targetDb, targetName) => {
        if (!sourceDb || !targetDb || !sourceName || !targetName)
            throw new Error('server-side copy requires source and target database/collection')
        try {
            const cursor = await sourceDb.collection(sourceName).aggregate([
                { $match: {} },
                { $out: targetSpec(targetDb, targetName) }
            ])
            await cursor.toArray()
        } catch (e) {
            if (!unsupportedOut(e)) throw e
            warn('MongoDB $out unavailable, using atomic temp+rename copy: ' + e.message)
            return fallbackCopy(sourceDb, sourceName, targetDb, targetName)
        }
        return targetDb.collection(targetName).countDocuments({})
    },

    // Exported for tests that inject a specific server failure.
    isUnsupportedOut: unsupportedOut
}

module.exports = mongoCopy
