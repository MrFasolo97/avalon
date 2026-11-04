const leaderHealth = require('../../leaderHealth')

module.exports = {
    init: (app) => {
        /**
         * @api {get} /leader/:account Leader Info
         * @apiName leader
         * @apiGroup Leaders
         * 
         * @apiParam {String} account Leader to query
         * 
         * @apiSuccess {String} name Username of leader
         * @apiSuccess {Integer} balance Leader account balance in terms of 0.01 DTUBE
         * @apiSuccess {Integer} node_appr Leader approval
         * @apiSuccess {String} pub_leader Leader signing public key of account
         * @apiSuccess {Integer} subs Subscriber count of leader
         * @apiSuccess {Integer} subbed Subscribed count of leader
         * @apiSuccess {Integer} sinceTs Timestamp of first block produced
         * @apiSuccess {Integer} sinceBlock Block number of filrft block produced
         * @apiSuccess {Integer} produced Number of blocks produced
         * @apiSuccess {Integer} missed Number of blocks missed
         * @apiSuccess {Integer} voters Number of voters for the leader
         * @apiSuccess {Integer} last Block number of last block produced
         * @apiSuccess {Integer} streak Consecutive proven missed scheduled turns
         * @apiSuccess {Boolean} jailed Whether the leader is soft-jailed
         * @apiSuccess {Integer} jailUntil Block height the jail expires at
         * @apiSuccess {Integer} jailLevel Jail backoff level
         * 
         * @apiError {String} error The error message
         */
        app.get('/leader/:account',(req,res) => {
            if (!req.params.account)
                res.status(404).send({error: 'account is required'})
            db.collection('accounts').findOne({name: req.params.account}, (e,acc) => {
                if (e) { logr.error('leader query failed', e); return res.status(500).send({error: 'query failed'}) }
                if (!acc) return res.status(404).send({error: 'account does not exist'})
                if (!leaderStats.leaders[acc.name] || (!acc.pub_leader && !leaderStats.leaders[acc.name].last))
                    return res.status(404).send({error: 'account does not have any leader-related activities'})
                const lh = leaderHealth.leaders[acc.name]
                res.send({
                    name: acc.name,
                    balance: acc.balance,
                    node_appr: acc.node_appr,
                    pub_leader: acc.pub_leader,
                    subs: acc.followers ? acc.followers.length : 0,
                    subbed: acc.follows ? acc.follows.length : 0,
                    sinceTs: leaderStats.leaders[acc.name].sinceTs,
                    sinceBlock: leaderStats.leaders[acc.name].sinceBlock,
                    produced: leaderStats.leaders[acc.name].produced,
                    missed: leaderStats.leaders[acc.name].missed,
                    voters: leaderStats.leaders[acc.name].voters,
                    last: leaderStats.leaders[acc.name].last,
                    streak: lh ? lh.streak : 0,
                    jailed: leaderHealth.isJailed(acc.name, chain.getLatestBlock()._id + 1),
                    jailUntil: lh && lh.jail ? lh.jail.untilBlock : -1,
                    jailLevel: lh && lh.jail ? lh.jail.level : 0
                })
            })
        })
    }
}