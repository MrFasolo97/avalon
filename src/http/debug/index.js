const rateLimit = require('express-rate-limit')
const crypto = require('crypto')

const debugLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    message: { error: 'too many debug requests' }
})

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

module.exports = {
    init: (app) => {
        // get in-memory data (intensive) - admin only
        app.get('/debug', debugLimiter, (req, res) => {
            if (process.env.DEBUG_TOKEN) {
                const bearer = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
                const queryToken = req.query.token
                if (!timingSafeEqual(bearer || queryToken || '', process.env.DEBUG_TOKEN))
                    return res.sendStatus(401)
            }
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
