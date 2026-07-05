const rateLimit = require('express-rate-limit')

const mineLimiter = rateLimit({
    windowMs: 3000,
    max: 1,
    message: { error: 'too many mine requests' }
})

const requiredToken = process.env.MINE_TOKEN

module.exports = {
    init: (app) => {
        // this suggests the node to produce a block and submit it
        app.get('/mineBlock', mineLimiter, (req, res) => {
            if (!requiredToken)
                return res.status(500).json({error: 'MINE_TOKEN not set'})
            if (req.query.token !== requiredToken)
                return res.status(401).send({error: 'invalid token'})
            delete p2p.recovering
            res.send(chain.getLatestBlock()._id.toString())
            chain.mineBlock(function (error, finalBlock) {
                if (error)
                    logr.error('ERROR refused block', finalBlock)
            })
        })
    }
}
