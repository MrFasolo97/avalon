const timeout_transact_async = 7500

module.exports = {
    init: (app) => {
        app.post('/transactWaitConfirm', (req, res) => {
            res.redirect(307, "/transact")
        })
    }
}
