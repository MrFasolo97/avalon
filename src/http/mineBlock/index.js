const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../auth')

const mineLimiter = rateLimit({
    windowMs: 3000,
    max: 1,
    message: { error: 'too many mine requests' }
})

module.exports = {
    init: (app) => {
        app.get('/mineBlock', mineLimiter, requireAuth(), (req, res) => {
            res.send(chain.getLatestBlock()._id.toString())
            chain.mineBlock(function (error, finalBlock) {
                if (error)
                    logr.error('ERROR refused block', finalBlock)
            })
        })
    }
}
