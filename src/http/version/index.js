const pkg = require('../../../package.json')
const { execSync } = require('child_process')
const path = require('path')

let commitHash = process.env.GIT_COMMIT || process.env.AVALON_COMMIT || ''
try {
    if (!commitHash)
        commitHash = execSync('git rev-parse --short HEAD', {
            cwd: path.join(__dirname, '../../..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
} catch (e) { commitHash = 'unknown' }
if (!commitHash) commitHash = 'unknown'

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
