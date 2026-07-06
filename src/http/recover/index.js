module.exports = {
    init: (app) => {
        app.get('/recover',(req,res) => {
            const requiredToken = process.env.RECOVER_TOKEN
            if (requiredToken) {
                const bearer = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
                if (bearer !== requiredToken && req.query.token !== requiredToken)
                    return res.status(401).send({error: 'invalid token'})
            }
            logr.warn('Manual recovery triggered from ' + req.ip)
            p2p.refresh(true)
            res.send({})
        })
    }
}