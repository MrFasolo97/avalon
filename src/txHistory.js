const cloneDeep = require('clone-deep')

let txHistory = {
    indexQueue: [],
    accounts: process.env.TX_HISTORY_ACCOUNTS ? process.env.TX_HISTORY_ACCOUNTS.split(',') : [],
    processBlock: (block) => {
        if (process.env.TX_HISTORY !== '1') return
        for (let t = 0; t < block.txs.length; t++) {
            const tx = block.txs[t]
            if (txHistory.accounts.length === 0 ||
                txHistory.accounts.includes(tx.sender) ||
                txHistory.accounts.includes(tx.data.target) ||
                txHistory.accounts.includes(tx.data.receiver) ||
                txHistory.accounts.includes(tx.data.pa) ||
                txHistory.accounts.includes(tx.data.author)) {
                let newTxItm = cloneDeep(tx)
                newTxItm._id = newTxItm.hash
                newTxItm.includedInBlock = block._id
                txHistory.indexQueue.push(newTxItm)
            }
        }
    },
    getWriteOps: () => {
        if (process.env.TX_HISTORY !== '1') return []
        let ops = []
        for (let i = 0; i < txHistory.indexQueue.length; i++) {
            let newTx = txHistory.indexQueue[i]
            ops.push((cb) => db.collection('txs').insertOne(newTx,cb))
        }
        txHistory.indexQueue = []
        return ops
    }
}

module.exports = txHistory