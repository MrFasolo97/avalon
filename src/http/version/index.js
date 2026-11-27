const pkg = require('../../../package.json')
const commitHash = require('../../commitHash').resolve()

module.exports = {
    init: (app) => {
        /**
         * @api {get} /version Node Version
         * @apiName version
         * @apiGroup Blockchain
         *
         * @apiSuccess {String} version The avalon package version (e.g. "2.3.0")
         * @apiSuccess {String} commit  Short git commit hash of the build
         */
        app.get('/version', (req, res) => {
            res.send({ version: pkg.version, commit: commitHash })
        })
    }
}
