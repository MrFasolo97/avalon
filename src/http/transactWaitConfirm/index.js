const timeout_transact_async = 7500

module.exports = {
    init: (app) => {
        app.post('/transactWaitConfirm', (req, res) => {
            let tx = req.body
            res.status(500).send({ error: "Endpoint removed" })
        })
    }
}
