// starting sub modules
logr = require('./logger.js')
config = require('./config.js').read(0)
p2p = require('./p2p.js')
chain = require('./chain.js')
transaction = require('./transaction.js')
cache = require('./cache.js')
validate = require('./validate')
eco = require('./economics.js')
rankings = require('./rankings.js')
consensus = require('./consensus')
leaderStats = require('./leaderStats')

const dao = require('./dao')
const daoMaster = require('./daoMaster')
const blocks = require('./blocks')
const mongo = require('./mongo')
const http = require('./http')

// verify node version
const allowNodeV = [18, 20, 22]
const currentNodeV = parseInt(process.versions.node.split('.')[0])
if (allowNodeV.indexOf(currentNodeV) === -1) {
    logr.fatal('Wrong NodeJS version. Allowed versions: v'+allowNodeV.join(', v'))
    process.exit(1)
} else logr.info('Correctly using NodeJS v'+process.versions.node)


let erroredRebuild = false

// init the database and load most recent blocks in memory directly
mongo.init(async (err, initialState) => {
    if (err) {
        logr.fatal('Failed to initialize database:', err);
        process.exit(1);
    }

    try {
        // Initialize blocks storage just once
        await blocks.init(initialState);

        // Check if we need genesis
        const needsGenesis = (blocks.isOpen && !blocks.lastBlock()) ||
                           (!blocks.isOpen && !(await mongo.lastBlock()));

        if (needsGenesis) {
            logr.info('Initializing genesis block');
            const genesisBlock = chain.getGenesisBlock();
            
            if (!blocks.isOpen) {
                await db.collection('blocks').insertOne(genesisBlock);
            } else {
                blocks.appendBlock(genesisBlock);
            }
            
            await mongo.initGenesis();
            chain.recentBlocks = [genesisBlock];
            chain.schedule = chain.getGenesisBlockWithSchedule();
            logr.info('Genesis initialization complete');
        }

        // Check if we need to initialize genesis
        const latestBlock = blocks.isOpen ? blocks.lastBlock() : await mongo.lastBlock();
        
        if (!latestBlock) {
            // Handle genesis case only once
            logr.info('Initializing genesis block');
            const genesisBlock = chain.getGenesisBlock();
            
            if (!blocks.isOpen) {
                await db.collection('blocks').insertOne(genesisBlock);
            } else {
                // Make sure we're not trying to re-add genesis
                if (blocks.height !== 0) {
                    throw new Error('Genesis block already exists');
                }
                blocks.appendBlock(genesisBlock);
            }
            
            //await mongo.initGenesis();
            logr.info('Genesis initialization complete');
            
            // Update latest block reference
            chain.recentBlocks = [genesisBlock];
            chain.schedule = chain.getGenesisBlockWithSchedule();
        }

        // Warmup accounts
        let timeStart = new Date().getTime()
        await cache.warmup('accounts', parseInt(process.env.WARMUP_ACCOUNTS))
        logr.info(Object.keys(cache.accounts).length+' accounts loaded in RAM in '+(new Date().getTime()-timeStart)+' ms')
        
        // Warmup contents
        timeStart = new Date().getTime()
        await cache.warmup('contents', parseInt(process.env.WARMUP_CONTENTS))
        logr.info(Object.keys(cache.contents).length+' contents loaded in RAM in '+(new Date().getTime()-timeStart)+' ms')
        
        // Warmup leaders
        timeStart = new Date().getTime()
        let leaderCount = await cache.warmupLeaders()
        logr.info(leaderCount+' leaders loaded in RAM in '+(new Date().getTime()-timeStart)+' ms')

        await chain.initCasper()
        await startFinalizationInterval();

        // Warmup leader stats
        await leaderStats.loadIndex()

        // Load proposal head ID and active proposals
        await dao.loadID()
        await dao.loadActiveFundRequests()
        await dao.loadActiveChainUpdateProposals()
        await dao.loadGovConfig()
        await daoMaster.loadID()

        // Rebuild chain state if specified
        let rebuildResumeBlock = initialState && initialState.headBlock ? initialState.headBlock+1 : 0
        let isResumingRebuild = process.env.REBUILD_STATE === '1' && rebuildResumeBlock

        // alert when rebuild without validation/signture verification, only use if you know what you are doing
        if (process.env.REBUILD_STATE === '1')
            if (process.env.REBUILD_NO_VALIDATE === '1')
                logr.info('Rebuilding without validation. Only use this if you know what you are doing!')
            else if (process.env.REBUILD_NO_VERIFY === '1')
                logr.info('Rebuilding without signature verification. Only use this if you know what you are doing!')

        if (process.env.REBUILD_STATE === '1' && !isResumingRebuild) {
            logr.info('Chain state rebuild requested'+(process.env.UNZIP_BLOCKS === '1' && !blocks.isOpen ? ', unzipping blocks.zip...' : ''))
            if (!blocks.isOpen)
                mongo.restoreBlocks((e)=>{
                    if (e) return logr.error(e)
                    startRebuild(0)
                })
            else
                startRebuild(0)
            return
        }

        let block = blocks.isOpen ? blocks.lastBlock() : await mongo.lastBlock()
        // Resuming an interrupted rebuild
        if (isResumingRebuild) {
            logr.info('Resuming interrupted rebuild from block ' + rebuildResumeBlock)
            config = require('./config').read(rebuildResumeBlock - 1)
            chain.restoredBlocks = block._id
            let blkScheduleStart = rebuildResumeBlock-1 - (rebuildResumeBlock-1)%config.leaders
            if (!blocks.isOpen)
                mongo.fillInMemoryBlocks(() => 
                    db.collection('blocks').findOne({_id:rebuildResumeBlock-1 - (rebuildResumeBlock-1)%config.leaders},(e,b) => {
                        chain.schedule = chain.minerSchedule(b)
                        startRebuild(rebuildResumeBlock)
                    }),rebuildResumeBlock)
            else {
                blocks.fillInMemoryBlocks(rebuildResumeBlock)
                chain.schedule = chain.minerSchedule(blocks.read(blkScheduleStart))
                startRebuild(rebuildResumeBlock)
            }
            return
        }
        logr.info('#' + block._id + ' is the latest block in our db')
        config = require('./config.js').read(block._id)
        if (blocks.isOpen) {
            blocks.fillInMemoryBlocks()
            startDaemon(initialState)
        } else
            mongo.fillInMemoryBlocks(() => startDaemon(initialState))
        http.init()
    } catch (e) {
        logr.error('Initialization failed:', e);
        process.exit(1);
    }
})

function startFinalizationInterval() {
    setInterval(() => {
        try {
            if (chain.recentBlocks?.length && chain.casper) {
                chain.finalizeBlocks();
            }
        } catch (e) {
            logr.error('Finalization interval error:', e);
        }
    }, 30000);
}

function startRebuild(startBlock) {
    let rebuildStartTime = new Date().getTime()
    chain.lastRebuildOutput = rebuildStartTime
    chain.rebuildState(startBlock,(e,headBlockNum) => {
        if (e) {
            erroredRebuild = true
            return logr.error('Error rebuilding chain at block',headBlockNum, e)
        } else if (headBlockNum <= chain.restoredBlocks)
            logr.info('Rebuild interrupted at block '+headBlockNum+', so far it took ' + (new Date().getTime() - rebuildStartTime) + ' ms.')
        else
            logr.info('Rebuilt ' + headBlockNum + ' blocks successfully in ' + (new Date().getTime() - rebuildStartTime) + ' ms')
        logr.info('Writing rebuild data to disk...')
        let cacheWriteStart = new Date().getTime()
        cache.writeToDisk(true,() => {
            logr.info('Rebuild data written to disk in ' + (new Date().getTime() - cacheWriteStart) + ' ms')
            if (chain.shuttingDown || process.env.TERMINATE_AFTER_REBUILD === '1') {
                if (blocks.isOpen)
                    blocks.close()
                return process.exit(0)
            }
            startDaemon()
        })
    })
}

async function initializeChain(state) {
    try {
        // Clear any existing blocks if rebuilding
        if (process.env.REBUILD_STATE === '1') {
            await db.collection('blocks').deleteMany({});
        }

        // Create genesis block if none exists
        const count = await db.collection('blocks').countDocuments();
        if (count === 0) {
            const genesis = chain.getGenesisBlock();
            await db.collection('blocks').insertOne(genesis);
            logr.info('Genesis block created:', genesis);
        }

        // Verify we have exactly one genesis block
        const genesisBlocks = await db.collection('blocks').find({_id: 0}).toArray();
        if (genesisBlocks.length !== 1) {
            throw new Error(`Found ${genesisBlocks.length} genesis blocks!`);
        }
        try {
            // After loading blocks...
            const latestBlock = chain.getLatestBlock();
            chain.schedule = chain.minerSchedule(latestBlock);
            logr.info('Mining schedule initialized');
        } catch (e) {
            logr.error('Chain initialization failed:', e);
            process.exit(1);
        }
        logr.info('Mining initialization state:', {
            hasSchedule: !!chain.schedule?.shuffle,
            latestBlock: chain.getLatestBlock()?._id,
            txPoolReady: typeof transaction.pool !== 'undefined',
            nodeOwner: !!process.env.NODE_OWNER
        });
        // In your main initialization
        if (typeof transaction.pool === 'undefined') {
            transaction.pool = [];
            logr.debug('Initialized transaction pool');
        }

        // 1. Initialize database and load blocks
        await mongo.init(state);

        // 2. Warm up essential caches
        await cache.warmup('accounts', parseInt(process.env.WARMUP_ACCOUNTS));
        await cache.warmupLeaders();
        if (!chain.recentBlocks.length) {
            chain.recentBlocks = [chain.getGenesisBlock()];
            logr.info('Initialized with genesis block');
        }
        // 3. Handle genesis case
        if (blocks.height === 0) {
            logr.info('Initializing new blockchain with genesis block');
            const genesisBlock = chain.getGenesisBlock();
            
            if (!blocks.isOpen) {
                await db.collection('blocks').insertOne(genesisBlock);
            } else {
                blocks.appendBlock(genesisBlock);
            }
            
            chain.recentBlocks = [genesisBlock];
            chain.schedule = chain.getGenesisBlockWithSchedule();
            
            logr.info('Genesis block initialized successfully');
            return true;
        }

        // 4. Normal case - existing chain
        const latestBlock = blocks.isOpen ? 
            blocks.lastBlock() : 
            await db.collection('blocks').findOne({}, {sort: {_id: -1}});
        
        if (!latestBlock) {
            throw new Error('Failed to load latest block');
        }

        chain.schedule = chain.minerSchedule(latestBlock);
        logr.info(`Mining schedule created for block ${latestBlock._id}`);
        return true;

    } catch (e) {
        logr.error('Chain initialization failed:', e);
        throw e;
    }
}

function startDaemon(state) {
    initializeChain(state)
        .then(success => {
            if (!success) {
                logr.error('Initialization failed, retrying...');
                setTimeout(startDaemon(state), 5000);
                return;
            }

            logr.info('Daemon started successfully');
        })
        .catch(e => {
            logr.error('Critical initialization error:', e);
            process.exit(1);
        });
}   

process.on('SIGINT', function() {
    if (typeof closing !== 'undefined') return
    closing = true
    chain.shuttingDown = true
    if (!erroredRebuild && chain.restoredBlocks && chain.getLatestBlock()._id < chain.restoredBlocks) return
    process.stdout.write('\r')
    logr.info('Received SIGINT, completing writer queue...')
    setInterval(() => {
        blocks.close()
        if (cache.writerQueue.queue.length === 0 && !cache.writerQueue.processing) {
            logr.info('Avalon exitted safely')
            process.exit(0)
        }
    },1000)
})
