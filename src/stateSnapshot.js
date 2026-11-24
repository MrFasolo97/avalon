// == Bounded state snapshots for automatic reorgs ==
//
// A proof-gated rollback must not drop the whole database and replay millions
// of blocks from genesis. Instead we keep a small number of Mongo state
// snapshots (derived collections only — the block store is never copied) and
// restore the newest one at/below the common ancestor. `chain.rebuildState()`
// then replays only the short canonical prefix from that snapshot to the
// ancestor, after which normal forward recovery takes over.
//
// Snapshots are written after a block's state flush, every
// STATE_SNAPSHOT_INTERVAL blocks (default 10000). STATE_SNAPSHOT_KEEP (default
// 3) bounds how many are retained. All operations are best-effort at write
// time and fail closed at restore time: no snapshot at/below the ancestor means
// no rollback, never a destructive fallback.

const META_COLLECTION = 'stateSnapshots'
// Derived state only. `blocks` is deliberately excluded: canonical blocks stay
// on disk (BSON or Mongo) and are the source of truth for the replay.
const COLLECTIONS = [
    'accounts', 'contents', 'proposals', 'proposalVotes', 'masterdao',
    'leaders', 'txs', 'distributed', 'notifications', 'playlists', 'state'
]

const snapshotCollection = (height, name) => 'stateSnapshot_' + height + '_' + name

const getDb = () => (typeof db !== 'undefined' && db) ? db : null
const warn = (msg) => {
    if (typeof logr !== 'undefined' && logr && typeof logr.warn === 'function') logr.warn(msg)
}

let saving = false

let stateSnapshot = {
    collections: COLLECTIONS,

    interval: () => {
        const n = parseInt(process.env.STATE_SNAPSHOT_INTERVAL === undefined
            ? '10000' : process.env.STATE_SNAPSHOT_INTERVAL, 10)
        return Number.isFinite(n) && n > 0 ? n : 0
    },

    keep: () => {
        const n = parseInt(process.env.STATE_SNAPSHOT_KEEP || '3', 10)
        return Number.isFinite(n) && n > 0 ? n : 3
    },

    // Snapshot the state as it stands at `height`. The metadata row is written
    // last (with ready:true) so an interrupted copy is never restoreable.
    save: async (height) => {
        const database = getDb()
        if (!database || !Number.isInteger(height) || height < 0) return false
        const meta = database.collection(META_COLLECTION)
        if (await meta.findOne({ _id: height, ready: true })) return false
        for (const name of COLLECTIONS) {
            const target = database.collection(snapshotCollection(height, name))
            await target.deleteMany({})
            const docs = await database.collection(name).find({}).toArray()
            if (docs.length) await target.insertMany(docs)
        }
        await meta.replaceOne({ _id: height }, {
            _id: height, height, ready: true, createdAt: new Date(), collections: COLLECTIONS
        }, { upsert: true })
        await stateSnapshot.prune()
        return true
    },

    // Bootstrap for a node that starts from an existing database with no
    // snapshots yet: capture its current head so a nearby reorg is possible.
    ensure: (height) => {
        if (!getDb() || !Number.isInteger(height)) return Promise.resolve(false)
        return stateSnapshot.latestAtOrBelow(height).then(latest => {
            if (latest !== null) return false
            return stateSnapshot.save(height).catch(e => {
                warn('Initial state snapshot failed: ' + e.message)
                return false
            })
        }).catch(() => false)
    },

    // Called after every successful block application. Synchronous work is
    // limited to the modulo check; the copy itself never blocks consensus.
    maybeSave: (height) => {
        const interval = stateSnapshot.interval()
        if (!interval || !Number.isInteger(height) || height < 0
            || height % interval !== 0 || saving || !getDb()) return Promise.resolve(false)
        saving = true
        return stateSnapshot.save(height).catch(e => {
            warn('State snapshot at #' + height + ' failed: ' + e.message)
            return false
        }).finally(() => { saving = false })
    },

    latestAtOrBelow: async (height) => {
        const database = getDb()
        if (!database || !Number.isInteger(height)) return null
        const rows = await database.collection(META_COLLECTION).find(
            { ready: true, height: { $lte: height } },
            { sort: { height: -1 }, limit: 1 }
        ).toArray()
        return rows && rows[0] ? rows[0].height : null
    },

    // Restores derived state to the newest snapshot at/below `height` and
    // returns the height that was restored (the caller replays from height+1).
    //
    // `opts.sourceDb` is where snapshot collections are read from (default: active
    // db). `opts.targetDb` is where derived collections are written (default:
    // sourceDb). This allows rollback to rebuild into a fresh temporary database
    // and swap it in only after a successful replay.
    restore: async (height, opts = {}) => {
        const sourceDb = opts.sourceDb || getDb()
        const targetDb = opts.targetDb || sourceDb
        if (!sourceDb || !targetDb) throw new Error('no database available for state snapshot restore')

        let snapshotHeight = null
        if (opts.snapshotHeight !== undefined) snapshotHeight = opts.snapshotHeight
        else {
            const rows = await sourceDb.collection(META_COLLECTION).find(
                { ready: true, height: { $lte: height } },
                { sort: { height: -1 }, limit: 1 }
            ).toArray()
            snapshotHeight = rows && rows[0] ? rows[0].height : null
        }
        if (snapshotHeight === null)
            throw new Error('no state snapshot at or below height ' + height)
        for (const name of COLLECTIONS) {
            await targetDb.collection(name).deleteMany({})
            const docs = await sourceDb.collection(snapshotCollection(snapshotHeight, name)).find({}).toArray()
            if (docs.length) await targetDb.collection(name).insertMany(docs)
        }
        // Keep the persisted head consistent with the restored state; the replay
        // advances it again while re-executing the retained canonical blocks.
        await targetDb.collection('state').updateOne(
            { _id: 0 }, { $set: { headBlock: snapshotHeight } }, { upsert: true }
        )
        return snapshotHeight
    },

    // Only the newest KEEP snapshots are usable; older copies are removed so a
    // long-running node does not accumulate full state copies forever.
    prune: async () => {
        const database = getDb()
        if (!database) return
        const rows = await database.collection(META_COLLECTION).find({}).sort({ height: -1 }).toArray()
        for (const row of rows.slice(stateSnapshot.keep())) {
            for (const name of COLLECTIONS)
                await database.collection(snapshotCollection(row.height, name)).deleteMany({})
            await database.collection(META_COLLECTION).deleteOne({ _id: row._id })
        }
    }
}

module.exports = stateSnapshot
