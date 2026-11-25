const db_name = process.env.DB_NAME || 'avalon'
const db_url = process.env.DB_URL || 'mongodb://localhost:27017'
const MongoClient = require('mongodb').MongoClient
const fs = require('fs')
const sha256File = require('sha256-file')
const spawn = require('child_process').spawn
const spawnSync = require('child_process').spawnSync

let mongo = {
    init: (cb) => {
        MongoClient.connect(db_url, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        }, async function(err, client) {
            if (err) {
                // A node restarted together with MongoDB (a coordinated resume /
                // flag day) can reach this before mongo has finished booting, and
                // a transient connection error used to kill the process — half the
                // network crashed on every restart (drills G10/G11). Retry with a
                // small backoff before giving up: nothing has been set up yet, so
                // re-running init() is safe.
                if ((mongo._connectAttempts = (mongo._connectAttempts || 0) + 1) < 30) {
                    logr.warn('MongoDB not ready (' + err.message + '), retry '
                        + mongo._connectAttempts + '/30 in 2s')
                    return setTimeout(() => mongo.init(cb), 2000)
                }
                logr.fatal('MongoDB connection failed: ' + err.message); process.exit(1)
            }
            mongo._connectAttempts = 0
            mongo.client = client
            mongo.dbName = db_name
            db = client.db(db_name)
            this.db = db
            mongo.db = db
            try {
                await this.db.executeDbAdminCommand({
                    setParameter: 1,
                    internalQueryExecMaxBlockingSortBytes: 335544320
                })
            } catch (e) {}
            logr.info('Connected to '+db_url.replace(/\/\/[^@/]*@/, '//[REDACTED]@')+'/'+this.db.databaseName)

            let state = await this.db.collection('state').findOne({_id: 0})

            // MongoDB init stops here when using blocks BSON store
            if (process.env.BLOCKS_DIR)
                return cb(state)

            // If a rebuild is specified, drop the database
            if (process.env.REBUILD_STATE === '1' && (!state || !state.headBlock))
                return db.dropDatabase(() => mongo.initGenesis().then(cb))

            // check if genesis block exists or not
            db.collection('blocks').findOne({_id: 0}, function(err, genesis) {
                if (err) throw err
                if (genesis) {
                    if (genesis.hash !== config.originHash) {
                        logr.fatal('Block #0 hash doesn\'t match config. Did you forget to db.dropDatabase() ?')
                        process.exit(1)
                    }
                    cb(state)
                } else mongo.initGenesis().then(cb)
            })
            
        })
    },
    initGenesis: async () => {
        if (process.env.REBUILD_STATE === '1')
            logr.info('Starting genesis for rebuild...')
        else
            logr.info('Block #0 not found. Starting genesis...')

        await mongo.addMongoIndexes()
        let genesisFolder = process.cwd()+'/genesis/'
        let genesisZip = genesisFolder+'genesis.zip'
        let mongoUri = db_url+'/'+db_name

        // Check if genesis.zip exists
        try {
            fs.statSync(genesisZip)
        } catch (err) {
            logr.warn('No genesis.zip file found')
            // if no genesis file, we create only the master account and empty block 0
            await mongo.insertMasterAccount()
            await mongo.insertBlockZero()
            return
        }
        
        // if there's a genesis file, we unzip and mongorestore it
        logr.info('Found genesis.zip file, checking sha256sum...')
        let fileHash = sha256File(genesisZip)
        logr.debug(config.originHash+'\t config.originHash')
        logr.debug(fileHash+'\t genesis.zip')
        if (fileHash !== config.originHash) {
            logr.fatal('Existing genesis.zip file does not match block #0 hash')
            process.exit(1)
        }
        
        logr.info('OK sha256sum, unzipping genesis.zip...')
        spawnSync('unzip',[genesisZip,'-d',genesisFolder])
        logr.info('Finished unzipping, importing data now...')

        await mongo.restore(mongoUri,genesisFolder)
        logr.info('Finished importing genesis data')
        await mongo.insertBlockZero()
    },
    restore: (mongoUri,folder) => {
        return new Promise((rs) => {
            let mongorestore = spawn('mongorestore', ['--uri='+mongoUri, '-d', db_name, folder])
            mongorestore.stderr.on('data', (data) => {
                data = data.toString().split('\n')
                for (let i = 0; i < data.length; i++) {
                    let line = data[i].split('\t')
                    if (line.length > 1 && line[1].indexOf(db_name+'.') > -1)
                        logr.debug(line[1])
                }
            })
            mongorestore.on('close', () => rs(true))
        })
    },
    insertMasterAccount: async () => {
        logr.info('Inserting new master account: '+config.masterName)
        await db.collection('accounts').insertOne({
            name: config.masterName,
            pub: config.masterPub,
            pub_leader: config.masterPubLeader || config.masterPub,
            balance: config.masterBalance,
            bw: {v:0,t:config.block0ts},
            vt: {v:0,t:config.block0ts},
            // we set those arbitrarily
            approves: [config.masterName],
            node_appr: config.masterBalance,
            follows: [],
            followers: [],
            keys: [],
            created: {
                by: '',
                ts: config.block0ts
            }
        }) 
    },
    insertBlockZero: async () => {
        if (process.env.BLOCKS_DIR) return
        logr.info('Inserting Block #0 with hash '+config.originHash)
        await db.collection('blocks').insertOne(chain.getGenesisBlock())
    },
    addMongoIndexes: async () => {
        await db.collection('accounts').createIndex({name:1})
        await db.collection('accounts').createIndex({balance:1})
        await db.collection('accounts').createIndex({node_appr:1})
        await db.collection('accounts').createIndex({pub:1})
        await db.collection('accounts').createIndex({'keys.pub':1})
        await db.collection('contents').createIndex({ts:1})
        await db.collection('contents').createIndex({author:1})
    },
    fillInMemoryBlocks: (cb,headBlock) => {
        let query = {}
        if (headBlock && Number.isInteger(headBlock) && headBlock > 0) query._id = {$lt: headBlock}
        const target = mongo._rebuildOriginalDb || db
        target.collection('blocks').find(query, {
            sort: {_id: -1},
            limit: config.ecoBlocksIncreasesSoon ? config.ecoBlocksIncreasesSoon : config.ecoBlocks
        }).toArray(function(err, blocks) {
            if (err) throw err
            chain.recentBlocks = blocks.reverse()
            eco.loadHistory()
            cb()
        })
    },
    lastBlock: () => new Promise((rs,rj) => {
        const target = mongo._rebuildOriginalDb || db
        target.collection('blocks').findOne({}, {
            sort: {_id: -1}
        }, function(err, block) {
            if (err) return rj(err)
            rs(block)
        })
    }),
    // Automatic reorg primitives. `truncateBlocks` removes the minority tail;
    // `resetDerivedState` restores the newest state snapshot at/below the
    // ancestor (never drops the database), leaving the validated block store
    // untouched. The node then replays only snapshot+1..ancestor with the normal
    // deterministic rebuild. If no usable snapshot exists the promise rejects
    // and the rollback fails closed.
    //
    // Rollback rebuilds derived state into a fresh temporary database and swaps
    // it in only on success. On any failure the temp DB is discarded and the
    // original database remains the active one, so a rebuild failure never
    // leaves the node with an empty active database.
    truncateBlocks: (height) => new Promise((rs, rj) => {
        if (!Number.isInteger(height) || height < 0) return rj(new Error('Invalid block height'))
        const target = mongo._rebuildOriginalDb || db
        target.collection('blocks').deleteMany({_id: {$gt: height}}, (e, res) => {
            if (e) return rj(e)
            rs(res && res.deletedCount)
        })
    }),
    hasStateSnapshotAtOrBelow: (height) => {
        const stateSnapshot = require('./stateSnapshot')
        return stateSnapshot.latestAtOrBelow(height).then(h => h !== null)
    },
    preflightStateSnapshotAtOrBelow: (height) => {
        const stateSnapshot = require('./stateSnapshot')
        if (typeof stateSnapshot.preflightAtOrBelow === 'function')
            return stateSnapshot.preflightAtOrBelow(height).then(h => h !== null)
        return stateSnapshot.latestAtOrBelow(height).then(h => h !== null)
    },
    resetDerivedState: (height) => (async () => {
        const stateSnapshot = require('./stateSnapshot')
        if (!mongo.client) throw new Error('mongo client not initialized')
        const originalDb = mongo._rebuildOriginalDb || db
        const tempDbName = mongo.dbName + '_rebuild_tmp'

        // Discard any stale temp DB from a previous interrupted attempt.
        try { await mongo.client.db(tempDbName).dropDatabase() } catch (e) {}

        const tempDb = mongo.client.db(tempDbName)
        const snapshotHeight = await stateSnapshot.restore(height, {
            sourceDb: originalDb,
            targetDb: tempDb
        })

        // Switch the active DB to the temp rebuild target. All derived-state
        // writes (cache flush, rebuild replay) go to temp until swapped or discarded.
        mongo._rebuildContext = {
            originalDb,
            tempDb,
            tempDbName,
            snapshotHeight
        }
        mongo._rebuildOriginalDb = originalDb
        db = tempDb
        mongo.db = tempDb

        // Indexes on the temp DB so replay/write paths behave like production.
        await mongo.addMongoIndexes()

        // The resolved height is the exact point the caller must replay from.
        return snapshotHeight
    })(),
    finalizeRebuildSwap: () => (async () => {
        const ctx = mongo._rebuildContext
        if (!ctx) return false
        const { originalDb, tempDb, tempDbName } = ctx
        const stateSnapshot = require('./stateSnapshot')
        const incoming = (name) => name + '_rebuild_incoming'

        // Phase 1: copy rebuilt collections into staging collections in the
        // original DB. The original derived collections are untouched, so a
        // failure here leaves the active DB intact.
        for (const name of stateSnapshot.collections) {
            const staging = originalDb.collection(incoming(name))
            await staging.deleteMany({})
            const docs = await tempDb.collection(name).find({}).toArray()
            if (docs.length) await staging.insertMany(docs)
        }

        // Phase 2: swap staging into place. renameCollection with dropTarget
        // replaces the original collection atomically per collection.
        for (const name of stateSnapshot.collections) {
            const stagingName = incoming(name)
            // Ensure staging exists even when empty (rename requires it).
            const stagingExists = await originalDb.listCollections({name: stagingName}).hasNext()
            if (!stagingExists) await originalDb.createCollection(stagingName)
            await originalDb.collection(stagingName).rename(name, { dropTarget: true })
        }

        // Recreate indexes on original DB.
        db = originalDb
        mongo.db = originalDb
        try {
            await mongo.addMongoIndexes()
        } catch (e) {
            logr.warn('Index ensure on original DB after rebuild swap failed: ' + e.message)
        }
        db = originalDb
        mongo.db = originalDb

        // Clean up temp DB. Failure to drop temp is non-fatal; original is active.
        try { await mongo.client.db(tempDbName).dropDatabase() } catch (e) {
            logr.warn('Could not drop rebuild temp DB ' + tempDbName + ': ' + e.message)
        }
        mongo._rebuildContext = null
        mongo._rebuildOriginalDb = null
        return true
    })(),
    discardRebuildTemp: () => (async () => {
        const ctx = mongo._rebuildContext
        if (!ctx) {
            // Ensure globals are not left pointing at a temp db if context was lost.
            if (mongo._rebuildOriginalDb) {
                db = mongo._rebuildOriginalDb
                mongo.db = mongo._rebuildOriginalDb
                mongo._rebuildOriginalDb = null
            }
            return false
        }
        const { originalDb, tempDbName } = ctx
        db = originalDb
        mongo.db = originalDb
        mongo._rebuildContext = null
        mongo._rebuildOriginalDb = null
        try { await mongo.client.db(tempDbName).dropDatabase() } catch (e) {
            logr.warn('Could not drop rebuild temp DB ' + tempDbName + ': ' + e.message)
        }
        return true
    })(),
    getRollbackMarker: () => (async () => {
        const target = mongo._rebuildOriginalDb || db
        return target.collection('state').findOne({ _id: 'rollback' })
    })(),
    setRollbackMarker: (marker) => (async () => {
        const target = mongo._rebuildOriginalDb || db
        const doc = Object.assign({ _id: 'rollback', ts: new Date().toISOString() }, marker || {})
        await target.collection('state').replaceOne({ _id: 'rollback' }, doc, { upsert: true })
        return true
    })(),
    clearRollbackMarker: () => (async () => {
        const target = mongo._rebuildOriginalDb || db
        await target.collection('state').deleteOne({ _id: 'rollback' })
        return true
    })(),
    restoreBlocks: (cb) => {
        let dump_dir = process.cwd() + '/dump'
        let dump_location = dump_dir + '/blocks.zip'
        let blocks_bson = dump_dir + '/blocks.bson'
        let blocks_meta = dump_dir + '/blocks.metadata.json'
        let mongoUri = db_url+'/'+db_name

        if (process.env.UNZIP_BLOCKS === '1')
            try {
                fs.statSync(dump_location)
            } catch (err) {
                return cb('blocks.zip file not found')
            }
        else
            try {
                fs.statSync(blocks_bson)
                fs.statSync(blocks_meta)
            } catch (e) {
                return cb('blocks mongo dump files not found')
            }

        // Drop the existing blocks collection and replace with the dump
        db.collection('blocks').drop(async (e,ok) => {
            if (!ok) return cb('Failed to drop existing blocks data')

            if (process.env.UNZIP_BLOCKS === '1') {
                spawnSync('unzip',[dump_location,'-d',dump_dir])
                logr.info('Finished unzipping, importing blocks now...')
            } else
                logr.info('Importing blocks for rebuild...')

            await mongo.restore(mongoUri,dump_dir)
            let gBlock = await db.collection('blocks').findOne({_id: 0})
            let block = await mongo.lastBlock()
            if (!gBlock) return cb('Genesis block not found in dump')
            if (gBlock.hash !== config.originHash) return cb('Genesis block hash in dump does not match config.originHash')

            logr.info('Finished importing ' + block._id + ' blocks')
            chain.restoredBlocks = block._id
            cb(null)
        })
    }
} 

module.exports = mongo