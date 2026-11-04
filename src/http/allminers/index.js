const leaderHealth = require('../../leaderHealth')

module.exports = {
    init: (app) => {
        /**
         * @api {get} /allminers Leader Full Rank
         * @apiName allminers
         * @apiGroup Leaders
         * 
         * @apiSuccess {Array} accounts List of accounts ranked by `node_appr` regardless of existence of a valid signing key.
         * @apiSuccess {Integer} rank Position in the `node_appr` ranking (1-based)
         * @apiSuccess {Boolean} jailed Whether the leader is soft-jailed (Layer S/H)
         * @apiSuccess {Boolean} eligible Whether the leader can be counted in the quorum (not jailed)
         */
        app.get('/allminers', (req, res) => {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100)
            db.collection('accounts').find({ node_appr: { $gt: 0 } }, {
                sort: { node_appr: -1 },
                limit
            }).toArray(function (err, accounts) {
                if (err) return res.status(500).send({ error: 'failed to fetch miners' })
                db.collection('leaders').find({ voters: { $gt: 0 } },{}).toArray((err,leaders) => {
                    if (err) return res.status(500).send({ error: 'failed to fetch leader stats' })
                    let leaderObj = {}
                    for (let i = 0; i < leaders.length; i++)
                        leaderObj[leaders[i]._id] = leaders[i]
                    const nextHeight = chain.getLatestBlock()._id + 1
                    for (let i = 0; i < accounts.length; i++) {
                        accounts[i].subbed = (accounts[i].follows ? accounts[i].follows.length : 0)
                        accounts[i].subs = (accounts[i].followers ? accounts[i].followers.length : 0)
                        delete accounts[i].follows
                        delete accounts[i].followers
                        delete accounts[i].keys
                        delete accounts[i].auths
                        // Layer S/H additive fields
                        const jailed = leaderHealth.isJailed(accounts[i].name, nextHeight)
                        accounts[i].rank = i + 1
                        accounts[i].jailed = jailed
                        accounts[i].eligible = !jailed
                        if (leaderObj[accounts[i].name]) {
                            accounts[i].leaderStat = leaderObj[accounts[i].name]
                            delete accounts[i].leaderStat._id
                        }
                    }
                    res.send(accounts)
                })
            })
        })
    }
}
