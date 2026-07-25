module.exports = {
    init: (app) => {
        /*
         * @api {post} /transactWaitConfirm TransactWaitConfirmResult
         * @apiName transact wait confirm
         * @apiGroup Broadcast
         * @apiDeprecated Use /transact instead
         */
        app.post('/transactWaitConfirm', (req, res) => {
            res.redirect(307, '/transact')
        })
    }
}
