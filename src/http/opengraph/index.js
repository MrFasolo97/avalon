const ogs = require('open-graph-scraper')
const { URL } = require('url')

const PRIVATE_RANGES = [
    /^https?:\/\/127\./,
    /^https?:\/\/10\./,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
    /^https?:\/\/192\.168\./,
    /^https?:\/\/0\./,
    /^https?:\/\/169\.254\./,
    /^https?:\/\/\[::1\]/,
    /^https?:\/\/\[f[cd][0-9a-f]{2}:/
]

function isPrivateURL(urlStr) {
    try {
        const parsed = new URL(urlStr)
        const host = parsed.hostname
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]')
            return true
        return PRIVATE_RANGES.some(r => r.test(urlStr))
    } catch {
        return true
    }
}

module.exports = {
    init: (app) => {
        // get open graph data for any url
        /**
         * @api {get} /opengraph/:url OpenGraph
         * @apiName opengraph
         * @apiGroup External
         * 
         * @apiParam {String} url The URL to query opengraph data of
         * 
         * @apiSuccess {Object} info The opengraph data
         */
        app.get('/opengraph/:url', (req, res) => {
            if (!req.params.url) {
                res.sendStatus(500)
                return
            }
            if (isPrivateURL(req.params.url))
                return res.status(400).send({error: 'invalid url'})
            ogs({ url: req.params.url, timeout: 5000, headers: { 'user-agent': 'facebookexternalhit/1.1 (+https://d.tube)' } }, function (error, results) {
                if (error) res.sendStatus(404)
                else res.send(results)
            })
        })
    }
}
