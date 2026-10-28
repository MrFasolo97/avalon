const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../auth')

const debugLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    message: { error: 'too many debug requests' }
})

module.exports = {
    init: (app) => {
        app.get('/debug', debugLimiter, requireAuth(), (req, res) => {
            res.send({
                consensus: {
                    height: chain.getLatestBlock()._id,
                    possBlocksCount: consensus.possBlocks.length,
                },
                chain: {
                    recentBlocksCount: chain.recentBlocks.length,
                    recentTxsCount: Object.keys(chain.recentTxs).length
                }
            })
        })
    }
}
