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
const rollbackMarker = require('./rollbackMarker')
const copyCollection = require('./mongoCopy')
// Derived state only. `blocks` is deliberately excluded: canonical blocks stay
// on disk (BSON or Mongo) and are the source of truth for the replay.
// `jailCheckpoint` (R5) is included so a rollback restores jail state together
// with the state it was folded from; the replay then continues from its height.
// Keep it as a plain constant: requiring leaderHealth here would create a
// circular dependency (chain -> stateSnapshot -> leaderHealth -> chain) and
// expose a partially-initialised module to callers.
const JAIL_CHECKPOINT_COLLECTION = 'jailCheckpoint'
const COLLECTIONS = [
    'accounts', 'contents', 'proposals', 'proposalVotes', 'masterdao',
    'leaders', 'txs', 'distributed', 'notifications', 'playlists', 'state',
    JAIL_CHECKPOINT_COLLECTION
]

const snapshotCollection = (height, name) => 'stateSnapshot_' + height + '_' + name

const getDb = () => (typeof db !== 'undefined' && db) ? db : null
const warn = (msg) => {
    if (typeof logr !== 'undefined' && logr && typeof logr.warn === 'function') logr.warn(msg)
}

let saving = false

// Fail loudly if someone ever adds the recovery marker to the derived set: a
// snapshot copy or a swap rename would destroy the crash-recovery signal (R9).
if (COLLECTIONS.indexOf(rollbackMarker.collection) !== -1)
    throw new Error('rollback marker collection must not be part of derived state snapshots')
if (COLLECTIONS.indexOf(JAIL_CHECKPOINT_COLLECTION) === -1)
    throw new Error('jail checkpoint must be part of derived state snapshots (R5)')

let stateSnapshot = {
    collections: COLLECTIONS,
    // Exposed so the rebuild swap (R9) can copy collections server-side too.
    serverCopy: (sourceDb, sourceName, targetDb, targetName) =>
        copyCollection.copy(sourceDb, sourceName, targetDb, targetName),

    enabled: () => {
        const v = String(process.env.AUTO_ROLLBACK || '0').toLowerCase()
        return v === '1' || v === 'true'
    },

    interval: () => {
        const n = parseInt(process.env.STATE_SNAPSHOT_INTERVAL === undefined
            ? '10000' : process.env.STATE_SNAPSHOT_INTERVAL, 10)
        return Number.isFinite(n) && n > 0 ? n : 0
    },

    keep: () => {
        const n = parseInt(process.env.STATE_SNAPSHOT_KEEP || '3', 10)
        return Number.isFinite(n) && n > 0 ? n : 3
    },

    // R8: a block-producing leader with AUTO_ROLLBACK=1 can miss turns while a
    // snapshot is taken. Leader signing is configured via NODE_OWNER_PRIV and
    // NODE_OWNER (the same pair chain.hashAndSignBlock uses); we widen the check
    // to the active set/schedule when available so standbys are warned too.
    warnIfLeaderNode: () => {
        if (!stateSnapshot.enabled()) return false
        const name = process.env.NODE_OWNER
        if (!name || !process.env.NODE_OWNER_PRIV) return false
        let elected = false
        try {
            const chainRef = (typeof chain !== 'undefined' && chain) ? chain : null
            const shuffle = chainRef && chainRef.schedule && chainRef.schedule.shuffle
            if (Array.isArray(shuffle))
                elected = shuffle.some(l => l && (l.name || l) === name)
            if (!elected && chainRef && typeof chainRef.activeLeaderSet === 'function')
                elected = chainRef.activeLeaderSet().some(l => l && (l.name || l) === name)
        } catch (e) {}
        warn('AUTO_ROLLBACK=1 is enabled on this block-producing leader (' + name
            + (elected ? ', currently in the active set' : ', signing key configured')
            + '): taking a state snapshot briefly pauses block application and can cause missed turns.'
            + ' AUTO_ROLLBACK=1 is recommended for non-leader/sync nodes only; disable it here'
            + ' (AUTO_ROLLBACK=0) on leaders.')
        return true
    },
    // Backwards-compatible name for callers/tests using the shorter form.
    warnIfLeader: () => stateSnapshot.warnIfLeaderNode(),

    // Snapshot the state as it stands at `height`. The metadata row is written
    // last (with ready:true) so an interrupted copy is never restoreable.
    save: async (height) => {
        if (!stateSnapshot.enabled()) return false
        const database = getDb()
        if (!database || !Number.isInteger(height) || height < 0) return false
        const meta = database.collection(META_COLLECTION)
        if (await meta.findOne({ _id: height, ready: true })) return false
        // R8: the copy must represent exactly one height. Callers invoke save()
        // after the state flush; refuse a stale head instead of silently
        // snapshotting a mix of heights.
        const stateDoc = await database.collection('state').findOne({ _id: 0 })
        if (stateDoc && Number.isInteger(stateDoc.headBlock) && stateDoc.headBlock !== height)
            throw new Error('cannot snapshot #' + height + ': state head is #' + stateDoc.headBlock)
        const collectionCounts = {}
        try {
            for (const name of COLLECTIONS)
                collectionCounts[name] = await copyCollection.copy(
                    database, name, database, snapshotCollection(height, name))
            await meta.replaceOne({ _id: height }, {
                _id: height, height, ready: true, createdAt: new Date(),
                collections: COLLECTIONS, collectionCounts
            }, { upsert: true })
        } catch (e) {
            // A failed copy must never leave a restoreable (or partially
            // restoreable) snapshot behind.
            for (const name of COLLECTIONS)
                try { await database.collection(snapshotCollection(height, name)).deleteMany({}) }
                catch (ignored) {}
            try { await meta.deleteOne({ _id: height }) } catch (ignored) {}
            throw e
        }
        await stateSnapshot.prune()
        return true
    },

    // Bootstrap for a node that starts from an existing database with no
    // snapshots yet: capture its current head so a nearby reorg is possible.
    ensure: (height) => {
        if (!stateSnapshot.enabled()) return Promise.resolve(false)
        if (!getDb() || !Number.isInteger(height)) return Promise.resolve(false)
        return stateSnapshot.latestAtOrBelow(height).then(latest => {
            if (latest !== null) return false
            return stateSnapshot.save(height).catch(e => {
                warn('Initial state snapshot failed: ' + e.message)
                return false
            })
        }).catch(() => false)
    },

    // Called after every successful block application. When enabled, the caller
    // must await this so snapshot creation is serialized with block application.
    maybeSave: (height) => {
        if (!stateSnapshot.enabled()) return Promise.resolve(false)
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

    // Pre-flight validation for rollback. Verifies snapshot exists, is ready,
    // matches height constraints, and is complete/integrity-checked before any
    // live state or block mutation.
    preflightAtOrBelow: async (height) => {
        const database = getDb()
        if (!database || !Number.isInteger(height)) return null
        const rows = await database.collection(META_COLLECTION).find(
            { ready: true, height: { $lte: height } },
            { sort: { height: -1 }, limit: 1 }
        ).toArray()
        const meta = rows && rows[0]
        if (!meta) return null
        if (meta.height !== meta._id)
            throw new Error('state snapshot metadata height mismatch: _id=' + meta._id + ' height=' + meta.height)
        const expected = Array.isArray(meta.collections) && meta.collections.length > 0
            ? meta.collections : COLLECTIONS
        for (const name of COLLECTIONS) {
            if (expected.indexOf(name) === -1)
                throw new Error('state snapshot #' + meta.height + ' missing collection metadata for ' + name)
            const snapName = snapshotCollection(meta.height, name)
            const exists = await database.listCollections({ name: snapName }).hasNext()
            if (!exists)
                throw new Error('state snapshot #' + meta.height + ' missing snapshot collection ' + snapName)
            if (meta.collectionCounts && Object.prototype.hasOwnProperty.call(meta.collectionCounts, name)) {
                const expectedCount = meta.collectionCounts[name]
                const actualCount = await database.collection(snapName).countDocuments({})
                if (actualCount !== expectedCount)
                    throw new Error('state snapshot #' + meta.height + ' integrity check failed for ' + name
                        + ': expected ' + expectedCount + ' docs, found ' + actualCount)
            }
        }
        return meta.height
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
        // `$out` replaces the target collection atomically; no Node-side cursor
        // batch loop (and no pre-delete window) is needed.
        for (const name of COLLECTIONS)
            await copyCollection.copy(sourceDb, snapshotCollection(snapshotHeight, name), targetDb, name)
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
