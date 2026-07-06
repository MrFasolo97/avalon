const TransactionType = require('./transactions').Types
const isEnabled = process.env.NOTIFICATIONS || false

notifications = {
    processBlock: (block) => {
        if (!isEnabled || (chain.restoredBlocks && chain.getLatestBlock()._id + config.notifPurge * config.notifPurgeAfter < chain.restoredBlocks)) return

        if (block._id % config.notifPurge === 0)
            notifications.purgeOld(block)

        for (let i = 0; i < block.txs.length; i++)
            notifications.processTx(block.txs[i], block.timestamp)
    },
    purgeOld: (block) => {
        let threshold = block.timestamp - config.notifPurge * config.notifPurgeAfter * config.blockTime
        db.collection('notifications').deleteMany({
            ts: {$lt: threshold}
        })
    },
    processTx: (tx, ts) => {
        let notif = {}
        switch (tx.type) {
        case TransactionType.APPROVE_NODE_OWNER:
        case TransactionType.FOLLOW:
            notif = {
                u: tx.data.target,
                tx: tx,
                ts: ts
            }
            db.collection('notifications').insertOne(notif, function(err) {
                if (err) throw err
            })
            break

        case TransactionType.TRANSFER:
            notif = {
                u: tx.data.receiver,
                tx: tx,
                ts: ts
            }
            db.collection('notifications').insertOne(notif, function(err) {
                if (err) throw err
            })
            break

        case TransactionType.COMMENT:
        case TransactionType.PROMOTED_COMMENT:
            // comment: see https://github.com/busyorg/busy-api/blob/develop/server.js#L125
                
            /** Find replies */
            if (tx.data.pa && tx.data.pa !== tx.sender) {
                notif = {
                    u: tx.data.pa,
                    tx: tx,
                    ts: ts
                }
                notif.tx.data.json = {}
                db.collection('notifications').insertOne(notif, function(err) {
                    if (err) throw err
                })
            }
        
            /** Find mentions */
            let content = JSON.stringify(tx.data.json)
            let words = content.split('@')
            let i = 1
            let mentions = 0
            while (mentions < config.notifMaxMentions && i<words.length) {
                for (let y = 0; y < words[i].length; y++) 
                    if (config.allowedUsernameChars.indexOf(words[i][y]) === -1) {
                        if (y > 0) {
                            let candidate = words[i].substring(0,y)
                            db.collection('accounts').findOne({name: candidate}, function(err, account) {
                                if (!err && account) {
                                    let mNotif = {
                                        u: candidate,
                                        tx: tx,
                                        ts: ts
                                    }
                                    delete mNotif.tx.data.json
                                    db.collection('notifications').insertOne(mNotif, function(err2) {
                                        if (err2) logr.error('Notification mention insert failed', err2)
                                    })
                                }
                            })
                            mentions++
                        }
                        break
                    }
                
                i++
            }
            break

        case TransactionType.VOTE:
        case TransactionType.TIPPED_VOTE:
            notif = {
                u: tx.data.author,
                tx: tx,
                ts: ts
            }
            db.collection('notifications').insertOne(notif, function(err) {
                if (err) throw err
            })
            break
        
        default:
            break
        }
    }
}

module.exports = notifications