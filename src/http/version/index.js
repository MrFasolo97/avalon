const pkg = require('../../../package.json')

module.exports = {
    init: (app) => {
        /**
         * @api {get} /version Node Version
         * @apiName version
         * @apiGroup Blockchain
         *
         * @apiSuccess {String} version The avalon package version (e.g. "2.0.0")
         */
        app.get('/version', (req, res) => {
            res.send({ version: pkg.version })
        })
    }
}
