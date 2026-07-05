module.exports = {
    init: (app) => {
        // get in-memory data (intensive) - admin only
        app.get('/debug', (req, res) => {
            if (req.query.token !== process.env.DEBUG_TOKEN && req.headers['authorization'] !== `Bearer ${process.env.DEBUG_TOKEN}`) {
                return res.sendStatus(401)
            }
            res.send({
                mempool: transaction.pool,
                consensus: {
                    possBlocks: consensus.possBlocks,
                    processed: consensus.processed,
                    validating: consensus.validating,
                },
                chain: {
                    recentBlocks: chain.recentBlocks,
                    recentTxs: chain.recentTxs
                }
            })
        })
    }
}
