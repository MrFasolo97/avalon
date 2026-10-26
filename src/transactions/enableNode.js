module.exports = {
    fields: ['pub'],
    validate: (tx, ts, legitUser, cb) => {
        // ENABLE_NODE is reused as a heartbeat (type 18). A heartbeat must come
        // from an account that is a leader candidate (has a leader key or has
        // been approved as a node, i.e. node_appr > 0). This prevents random
        // accounts from spamming zero-bandwidth txs while still allowing a
        // former leader whose key was temporarily unset to re-register.
        if (!legitUser || (!legitUser.pub_leader && !(legitUser.node_appr > 0))) {
            cb(false, 'heartbeat sender is not a registered leader candidate')
            return
        }
        cb(true)
    },
    execute: (tx, ts, cb) => {
        // because if key is incorrect, we just unset it
        if (validate.publicKey(tx.data.pub, config.accountMaxLength))
            cache.updateOne('accounts', {
                name: tx.sender
            },{ $set: {
                pub_leader: tx.data.pub
            }}, function(){
                cache.addLeader(tx.sender,false,() => cb(true))
            })
        else
            cache.updateOne('accounts', {
                name: tx.sender
            },{ $unset: {
                pub_leader: ''
            }}, function(){
                cache.removeLeader(tx.sender)
                cb(true)
            })
    }
}
