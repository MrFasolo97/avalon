const rateLimit = require('express-rate-limit')

const debugLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    message: { error: 'too many debug requests' }
})

module.exports = {
    init: (app) => {
        // get in-memory data (intensive) - admin only
        app.get('/debug', debugLimiter, (req, res) => {
            if (process.env.DEBUG_TOKEN) {
                const bearer = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
                if (bearer !== process.env.DEBUG_TOKEN && req.query.token !== process.env.DEBUG_TOKEN)
                    return res.sendStatus(401)
            }
            res.send({
                consensus: {
                    height: chain.getLatestBlock()._id,
                    possBlocksCount: consensus.possBlocks.length,
                },
                chain: {
                    recentBlocksCount: chain.recentBlocks.length,
                    recentTxsCount: chain.recentTxs.length
                }
            })
        })
    }
}
