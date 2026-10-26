module.exports = {
    fields: ['pub'],
    validate: (tx, ts, legitUser, cb) => {
        // ENABLE_NODE is reused as a heartbeat (type 18). A heartbeat must come
        // from an account that has been a leader (pub_leader set) so random
        // accounts cannot spam zero-bandwidth txs. The pub field is validated
        // during execution; an invalid pub simply unsets the leader key.
        if (!legitUser || !legitUser.pub_leader) {
            cb(false, 'heartbeat sender is not a registered leader')
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
