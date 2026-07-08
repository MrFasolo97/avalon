const crypto = require('crypto')
const rateLimit = require('express-rate-limit')

const recoverLimiter = rateLimit({
    windowMs: 60000,
    max: 3,
    message: { error: 'too many recover requests' }
})

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

module.exports = {
    init: (app) => {
        app.get('/recover', recoverLimiter, (req, res) => {
            const requiredToken = process.env.RECOVER_TOKEN
            if (!requiredToken) {
                logr.error('/recover: RECOVER_TOKEN not set, refusing unauthenticated access')
                return res.status(500).send({ error: 'recover not configured' })
            }
            const bearer = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
            const queryToken = req.query.token
            if (!timingSafeEqual(bearer || queryToken || '', requiredToken))
                return res.status(401).send({ error: 'invalid token' })
            logr.warn('Manual recovery triggered from ' + req.ip)
            p2p.refresh(true)
            res.send({})
        })
    }
}