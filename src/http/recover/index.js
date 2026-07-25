const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../auth')

const recoverLimiter = rateLimit({
    windowMs: 60000,
    max: 3,
    message: { error: 'too many recover requests' }
})

module.exports = {
    init: (app) => {
        app.get('/recover', recoverLimiter, requireAuth(), (req, res) => {
            logr.warn('Manual recovery triggered from ' + req.ip)
            p2p.refresh(true)
            res.send({})
        })
    }
}
