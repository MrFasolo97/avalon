const rateLimit = require('express-rate-limit')

const txLimiter = rateLimit({
    windowMs: 1000,
    max: 5,
    message: { error: 'too many requests' }
})

module.exports = {
    init: (app) => {
        /*
         * @api {post} /transactWaitConfirm TransactWaitConfirmResult
         * @apiName transact wait confirm
         * @apiGroup Broadcast
         * @apiDeprecated Use /transact instead
         */
        app.post('/transactWaitConfirm', txLimiter, (req, res) => {
            res.redirect(307, '/transact')
        })
    }
}
