const fs = require('fs')
const assert = require('assert')
const BSON = require('bson')
const logr = require('./logger')
const mongo = require('./mongo')
const isRebuild = process.env.REBUILD_STATE === '1'
let isRebuiling = false

let blocks = {
    fd: 0,
    fdIndex: 0,
    height: 0,
    bsonSize: BigInt(0),
    dataDir: process.env.BLOCKS_DIR ? process.env.BLOCKS_DIR.replace(/\/$/,''): '',
    isOpen: false,
    notOpenError: 'Blockchain is not open',
    finalizedBlocks: new Set(), // Track finalized block hashes
    unfinalizedBlocks: new Map(), // Track pending blocks
    init: async (state) => {
        if (!process.env.BLOCKS_DIR) return
        blocks.loadFinalizedState();
        let bsonPath = blocks.dataDir+'/blocks.bson'
        let indexPath = blocks.dataDir+'/blocks.index'

        // If blocks.bson does not exist, initialize genesis state
        if (!fs.existsSync(bsonPath)) {
            if (isRebuild) {
                logr.fatal('Cannot rebuild from non-existent blocks.bson file')
                process.exit(1)
            }
            await mongo.initGenesis()
            isRebuiling = true
        }

        // Create files if not exists already
        blocks.touch()

        // Open blocks.bson file
        logr.info('Opening blockchain database at '+blocks.dataDir+'...')
        blocks.fd = fs.openSync(bsonPath,'a+')
        blocks.bsonSize = BigInt(fs.statSync(bsonPath).size)

        // Open blocks.index file
        blocks.fdIndex = fs.openSync(indexPath,'a+')

        let indexSize = fs.statSync(indexPath).size
        blocks.height = (indexSize / 8) - 1
        blocks.isOpen = true

        // Determine if resumption of index creation is required
        let resumeIndex = false
        if (indexSize > 0) {
            assert(indexSize % 8 === 0, 'Size of index file should be in multiple of 8')
            let docPosition = BigInt(0)
            let docSizeBuf = Buffer.alloc(4)
            let docIndexBuf = Buffer.alloc(8)
            fs.readSync(blocks.fdIndex,docIndexBuf,{offset: 0, position: indexSize-8, length: 8})
            docPosition = BigInt(Number(BigInt(docIndexBuf.readUInt32LE(0)) << 8n) + docIndexBuf.readUInt32LE(4))
            assert(docPosition < blocks.bsonSize, 'Latest indexed position greater than or equal to blocks.bson size')
            fs.readSync(blocks.fd,docSizeBuf,{offset: 0, position: docPosition, length: 4})
            let docSize = BigInt(docSizeBuf.readInt32LE(0))
            docPosition += docSize
            if (docPosition < blocks.bsonSize) {
                resumeIndex = true
                logr.info('Resuming index creation from block',blocks.height)
                blocks.reconstructIndex(docSizeBuf,docPosition,blocks.height+1)
            }
        }

        // Reconstruct index file if empty
        if (blocks.bsonSize > 0n && blocks.height === -1)
            blocks.reconstructIndex()
        else if (blocks.bsonSize === 0n)
            if (blocks.height > -1) {
                logr.fatal('Could not read empty blockchain and non-empty index file')
                blocks.close()
                process.exit(1)
            } else {
                logr.info('Inserting Block #0 with hash '+config.originHash)
                blocks.appendBlock(chain.getGenesisBlock())
            }
        else
            logr.info('Opened blockchain with latest block #'+blocks.height)

        const hasState = state && state.headBlock
        if (hasState && state.headBlock > blocks.height) {
            logr.fatal('Head block state exceeds blockchain height')
            blocks.close()
            process.exit(1)
        }

        if (isRebuild && !hasState && !isRebuiling) {
            await db.dropDatabase()
            await mongo.initGenesis()
        }
        if (isRebuild)
            chain.restoredBlocks = blocks.height
    },
    touch: () => {
        let bsonPath = blocks.dataDir+'/blocks.bson'
        let indexPath = blocks.dataDir+'/blocks.bson'
        if (!fs.existsSync(bsonPath))
            fs.closeSync(fs.openSync(bsonPath,'w'))
        if (!fs.existsSync(indexPath))
            fs.closeSync(fs.openSync(indexPath,'w'))
    },
    reconstructIndex: (currentDocSizeBuf, currentDocPosition, currentBlockHeight) => {
        assert(blocks.isOpen,blocks.notOpenError)
        logr.info('Reconstructing blocks BSON index file...')

        let startTime = new Date().getTime()
        let indexBuf = Buffer.alloc(8)
        let docSizeBuf = currentDocSizeBuf || Buffer.alloc(4)
        let docPosition = currentDocPosition || BigInt(0)
        let blockHeight = currentBlockHeight || 0
        while (docPosition < blocks.bsonSize) {
            fs.readSync(blocks.fd,docSizeBuf,{offset: 0, position: Number(docPosition), length: 4})
            indexBuf.writeUInt32LE(Number(docPosition >> 8n), 0)
            indexBuf.writeUInt32LE(Number(docPosition & 0xFFn), 4)
            fs.writeSync(blocks.fdIndex,indexBuf)
            docPosition += BigInt(docSizeBuf.readInt32LE(0))
            blockHeight++
        }
        blocks.height = blockHeight - 1

        logr.info('Index reconstructed up to block #'+blocks.height+' in '+(new Date().getTime()-startTime)+'ms')
    },
    appendBlock: (newBlock) => {
        if (this.height >= 0 && newBlock._id !== this.height + 1) {
            throw new Error(`Cannot append block ${block._id} to height ${this.height}`);
        }
        assert(blocks.isOpen,blocks.notOpenError)
        if ( newBlock._id !== 0 ) {
            assert(newBlock._id === blocks.height,'could not append non-next block') 
        }
        // Track as unfinalized first
        blocks.unfinalizedBlocks.set(newBlock.hash, {
            block: newBlock,
            votes: new Set()
        });
        let serializedBlock = BSON.serialize(newBlock)
        let newBlockSize = BigInt(serializedBlock.length)
        fs.writeSync(blocks.fd,serializedBlock)
        blocks.appendIndex(blocks.bsonSize)
        blocks.bsonSize += newBlockSize
        blocks.height++
    },
    appendIndex: (pos) => {
        assert(blocks.isOpen,blocks.notOpenError)
        let indexBuf = Buffer.alloc(8)
        indexBuf.writeUInt32LE(Number(pos >> 8n), 0)
        indexBuf.writeUInt32LE(Number(pos & 0xFFn), 4)
        fs.writeSync(blocks.fdIndex,indexBuf)
    },
    finalizeBlock: (blockHash) => {
        if (!blocks.unfinalizedBlocks.has(blockHash)) {
            return false;
        }

        const { block } = blocks.unfinalizedBlocks.get(blockHash);
        
        // Move to finalized
        blocks.finalizedBlocks.add(blockHash);
        blocks.unfinalizedBlocks.delete(blockHash);
        
        // Release UTXO locks
        transaction.releaseBlockLocks(blockHash);
        
        // Persist finalized state
        this.persistFinalizedState();
        
        return true;
    },

    persistFinalizedState: () => {
        // Write finalized blocks to disk
        const finalizedPath = `${blocks.dataDir}/finalized.json`;
        const finalizedData = {
            height: blocks.height,
            finalized: Array.from(blocks.finalizedBlocks)
        };
        
        fs.writeFileSync(finalizedPath, JSON.stringify(finalizedData), 'utf8');
    },

    loadFinalizedState: () => {
        const finalizedPath = `${blocks.dataDir}/finalized.json`;
        if (fs.existsSync(finalizedPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(finalizedPath, 'utf8'));
                blocks.finalizedBlocks = new Set(data.finalized);
                return true;
            } catch (e) {
                logr.error('Error loading finalized blocks:', e);
            }
        }
        return false;
    },
    handleReorg: (newHead, chain) => {
        if (!blocks.isOpen) throw new Error(blocks.notOpenError);

        // If we have finalized blocks, check the reorg doesn't conflict
        if (blocks.finalizedBlocks.size > 0) {
            // Find the earliest finalized block
            let earliestFinalized = null;
            for (const hash of blocks.finalizedBlocks) {
                const block = blocks.getBlockByHash(hash);
                if (!earliestFinalized || block._id < earliestFinalized._id) {
                    earliestFinalized = block;
                }
            }

            if (earliestFinalized && newHead._id <= earliestFinalized._id) {
                return false;
            }
        }

        // Build new unfinalized blocks map
        const newUnfinalized = new Map();
        let current = newHead;
        let depth = 0;
        const maxReorgDepth = config.maxReorgDepth || 100; // Safety limit

        while (current && depth < maxReorgDepth) {
            // Stop if we hit a finalized block
            if (blocks.finalizedBlocks.has(current.hash)) {
                break;
            }

            // Add to new unfinalized set
            newUnfinalized.set(current.hash, {
                block: current,
                votes: blocks.unfinalizedBlocks.get(current.hash)?.votes || new Set()
            });

            // Move to parent
            try {
                current = chain.getBlockByHash(current.phash);
                depth++;
            } catch (e) {
                logr.warn('Error during reorg - missing block:', current.phash);
                break;
            }
        }

        // Only apply if we successfully built the new chain
        if (depth < maxReorgDepth) {
            blocks.unfinalizedBlocks = newUnfinalized;
            return true;
        }

        logr.warn('Reorg exceeded maximum depth');
        return false;
    },
    read: (blockNum = 0) => {
        if (!blocks.isOpen)
            throw new Error(blocks.notOpenError)
        else if (isNaN(blockNum) || parseInt(blockNum) < 0)
            throw new Error('Block number must be a valid non-negative integer')
        else if (blockNum > blocks.height)
            throw new Error('Block not found')
        
        // Read position of block from index
        let indexBuf = Buffer.alloc(8)
        fs.readSync(blocks.fdIndex,indexBuf,{offset: 0, position: blockNum*8, length: 8})
        let docPosition = Number(BigInt(indexBuf.readUInt32LE(0)) << 8n) + indexBuf.readUInt32LE(4)
        assert(BigInt(docPosition) < blocks.bsonSize,'Bson position out of range')

        // Read blocks BSON at position of block
        let docSizeBuf = Buffer.alloc(4)
        fs.readSync(blocks.fd,docSizeBuf,{offset: 0, position: docPosition, length: 4})
        let docSize = docSizeBuf.readInt32LE(0)
        let docBuf = Buffer.alloc(docSize)
        fs.readSync(blocks.fd,docBuf,{offset: 0, position: docPosition, length: docSize})
        let block = BSON.deserialize(docBuf);
        block.finalized = blocks.finalizedBlocks.has(block.hash);
        return BSON.deserialize(docBuf)
    },
    readRange: (start,end) => {
        if (!blocks.isOpen)
            throw new Error(blocks.notOpenError)
        else if (isNaN(start))
            throw new Error('Start block must be a valid non-negative integer')
        else if (isNaN(end) || parseInt(end) < 0)
            throw new Error('End block must be a valid non-negative integer')
        else if (start > end)
            throw new Error('Start block cannot be greater than end block')
        if (parseInt(start) < 0)
            start = 0
        if (start > blocks.height)
            return []
        if (end > blocks.height)
            end = blocks.height
        
        // Read position of start block and end block from index
        let indexBuf = Buffer.alloc(8)
        let indexBufEnd = Buffer.alloc(8)
        fs.readSync(blocks.fdIndex,indexBuf,{offset: 0, position: start*8, length: 8})
        fs.readSync(blocks.fdIndex,indexBufEnd,{offset: 0, position: end*8, length: 8})
        let docPosition = Number(BigInt(indexBuf.readUInt32LE(0)) << 8n) + indexBuf.readUInt32LE(4)
        let docPositionEnd = Number(BigInt(indexBufEnd.readUInt32LE(0)) << 8n) + indexBufEnd.readUInt32LE(4)
        assert(BigInt(docPosition) < blocks.bsonSize && BigInt(docPositionEnd) < blocks.bsonSize,'Bson position out of range')

        // Read blocks BSON from start position to end position of last block
        let docSizeBufEnd = Buffer.alloc(4)
        fs.readSync(blocks.fd,docSizeBufEnd,{offset: 0, position: docPositionEnd, length: 4})
        let docSizeEnd = docSizeBufEnd.readInt32LE(0)
        let rangeSize = docPositionEnd-docPosition+docSizeEnd
        let docBuf = Buffer.alloc(rangeSize)
        let docArr = []
        fs.readSync(blocks.fd,docBuf,{offset: 0, position: docPosition, length: rangeSize})
        BSON.deserializeStream(docBuf,0,end-start+1,docArr,0)
        return docArr
    },
    fillInMemoryBlocks: (headBlock = blocks.height+1) => {
        assert(blocks.isOpen,blocks.notOpenError)
        let end = headBlock-1
        let start = end - (config.ecoBlocksIncreasesSoon ? config.ecoBlocksIncreasesSoon : config.ecoBlocks) + 1
        chain.recentBlocks = blocks.readRange(start,end)
        eco.loadHistory()
    },
    lastBlock: () => blocks.read(blocks.height),
    close: () => {
        if (blocks.isOpen) {
            fs.closeSync(blocks.fd)
            fs.closeSync(blocks.fdIndex)
            logr.info('Blocks BSON file closed successfully')
        }
    }
}

module.exports = blocks