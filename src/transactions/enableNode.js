module.exports = {
    fields: ['pub'],
    validate: (tx, ts, legitUser, cb) => {
        // ENABLE_NODE is reused as a heartbeat (type 18). It serves both initial
        // leader registration (account has no pub_leader yet) and the wake-up
        // envelope for a jailed leader. Therefore we only require a valid,
        // existing account. The jail kernel ignores heartbeats from accounts
        // that are not actually jailed, so this does not weaken consensus.
        if (!legitUser) {
            cb(false, 'heartbeat sender account not found')
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
