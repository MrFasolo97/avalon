const fs = require('fs')
const BSON = require('bson')
const logr = require('./logger')
const mongo = require('./mongo')
const isRebuild = process.env.REBUILD_STATE === '1'

let blocks = {
    fd: 0,
    fdIndex: 0,
    height: 0,
    bsonSize: BigInt(0),
    dataDir: process.env.BLOCKS_DIR ? process.env.BLOCKS_DIR.replace(/\/$/,''): '',
    isOpen: false,
    notOpenError: 'Blockchain is not open',
    init: async (state) => {
        if (!process.env.BLOCKS_DIR) return

        let bsonPath = blocks.dataDir+'/blocks.bson'
        let indexPath = blocks.dataDir+'/blocks.index'

        // If blocks.bson does not exist, initialize genesis state
        if (!fs.existsSync(bsonPath)) {
            if (isRebuild) {
                logr.fatal('Cannot rebuild from non-existent blocks.bson file')
                process.exit(1)
            }
            await mongo.initGenesis()
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
        if (indexSize > 0) {
            if (indexSize % 8 !== 0) {
                logr.fatal('Corrupted index file at ' + indexPath + ': size ' + indexSize + ' is not multiple of 8')
                blocks.close()
                process.exit(1)
            }
            let docPosition = BigInt(0)
            let docSizeBuf = Buffer.alloc(4)
            let docIndexBuf = Buffer.alloc(8)
            fs.readSync(blocks.fdIndex,docIndexBuf,{offset: 0, position: indexSize-8, length: 8})
            docPosition = BigInt(Number(BigInt(docIndexBuf.readUInt32LE(0)) << 8n) + docIndexBuf.readUInt32LE(4))
            if (docPosition >= blocks.bsonSize) {
                logr.fatal('Indexed position ' + docPosition + ' exceeds blocks.bson size ' + blocks.bsonSize)
                blocks.close()
                process.exit(1)
            }
            fs.readSync(blocks.fd,docSizeBuf,{offset: 0, position: docPosition, length: 4})
            let docSize = BigInt(docSizeBuf.readInt32LE(0))
            docPosition += docSize
            if (docPosition < blocks.bsonSize) {
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

        if (isRebuild && !hasState) {
            await db.dropDatabase()
            await mongo.initGenesis()
        }
        if (isRebuild)
            chain.restoredBlocks = blocks.height
    },
    touch: () => {
        let bsonPath = blocks.dataDir+'/blocks.bson'
        let indexPath = blocks.dataDir+'/blocks.index'
        if (!fs.existsSync(bsonPath))
            fs.closeSync(fs.openSync(bsonPath,'w'))
        if (!fs.existsSync(indexPath))
            fs.closeSync(fs.openSync(indexPath,'w'))
    },
    reconstructIndex: (currentDocSizeBuf, currentDocPosition, currentBlockHeight) => {
        if (!blocks.isOpen) { logr.fatal(blocks.notOpenError); process.exit(1) }
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
        if (!blocks.isOpen) { logr.fatal(blocks.notOpenError); process.exit(1) }
        if (newBlock._id !== blocks.height+1) { logr.fatal('could not append non-next block: expected ' + (blocks.height+1) + ' got ' + newBlock._id); process.exit(1) }
        let serializedBlock = BSON.serialize(newBlock)
        let newBlockSize = BigInt(serializedBlock.length)
        fs.writeSync(blocks.fd,serializedBlock)
        blocks.appendIndex(blocks.bsonSize)
        blocks.bsonSize += newBlockSize
        blocks.height++
    },
    appendIndex: (pos) => {
        if (!blocks.isOpen) { logr.fatal(blocks.notOpenError); process.exit(1) }
        let indexBuf = Buffer.alloc(8)
        indexBuf.writeUInt32LE(Number(pos >> 8n), 0)
        indexBuf.writeUInt32LE(Number(pos & 0xFFn), 4)
        fs.writeSync(blocks.fdIndex,indexBuf)
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
        if (BigInt(docPosition) >= blocks.bsonSize)
            throw new Error('Bson position ' + docPosition + ' out of range (size ' + blocks.bsonSize + ')')

        // Read blocks BSON at position of block
        let docSizeBuf = Buffer.alloc(4)
        fs.readSync(blocks.fd,docSizeBuf,{offset: 0, position: docPosition, length: 4})
        let docSize = docSizeBuf.readInt32LE(0)
        let docBuf = Buffer.alloc(docSize)
        fs.readSync(blocks.fd,docBuf,{offset: 0, position: docPosition, length: docSize})
        try {
            return BSON.deserialize(docBuf)
        } catch (e) {
            throw new Error('Failed to deserialize block #' + blockNum + ': ' + e.message)
        }
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
        if (BigInt(docPosition) >= blocks.bsonSize || BigInt(docPositionEnd) >= blocks.bsonSize) 
            throw new Error('Bson position out of range in readRange')
        

        // Read blocks BSON from start position to end position of last block
        let docSizeBufEnd = Buffer.alloc(4)
        fs.readSync(blocks.fd,docSizeBufEnd,{offset: 0, position: docPositionEnd, length: 4})
        let docSizeEnd = docSizeBufEnd.readInt32LE(0)
        let rangeSize = docPositionEnd-docPosition+docSizeEnd
        let docBuf = Buffer.alloc(rangeSize)
        let docArr = []
        fs.readSync(blocks.fd,docBuf,{offset: 0, position: docPosition, length: rangeSize})
        try {
            BSON.deserializeStream(docBuf,0,end-start+1,docArr,0)
        } catch (e) {
            throw new Error('Failed to deserialize blocks ' + start + '-' + end + ': ' + e.message)
        }
        return docArr
    },
    fillInMemoryBlocks: (headBlock = blocks.height+1) => {
        if (!blocks.isOpen) {
            logr.fatal(blocks.notOpenError)
            process.exit(1)
        }
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