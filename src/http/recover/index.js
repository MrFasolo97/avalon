const crypto = require('crypto')

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

module.exports = {
    init: (app) => {
        app.get('/recover',(req,res) => {
            const requiredToken = process.env.RECOVER_TOKEN
            if (requiredToken) {
                const bearer = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
                const queryToken = req.query.token
                if (!timingSafeEqual(bearer || queryToken || '', requiredToken))
                    return res.status(401).send({error: 'invalid token'})
            }
            logr.warn('Manual recovery triggered from ' + req.ip)
            p2p.refresh(true)
            res.send({})
        })
    }
}