const rateLimit = require('express-rate-limit')
const crypto = require('crypto')

const mineLimiter = rateLimit({
    windowMs: 3000,
    max: 1,
    message: { error: 'too many mine requests' }
})

const requiredToken = process.env.MINE_TOKEN

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

module.exports = {
    init: (app) => {
        // this suggests the node to produce a block and submit it
        app.get('/mineBlock', mineLimiter, (req, res) => {
            if (requiredToken) {
                const bearer = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
                const queryToken = req.query.token
                if (!timingSafeEqual(bearer || queryToken || '', requiredToken))
                    return res.status(401).send({error: 'invalid token'})
            }
            res.send(chain.getLatestBlock()._id.toString())
            chain.mineBlock(function (error, finalBlock) {
                if (error)
                    logr.error('ERROR refused block', finalBlock)
            })
        })
    }
}
