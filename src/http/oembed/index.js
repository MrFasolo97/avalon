const { extract } = require('oembed-parser')
const rateLimit = require('express-rate-limit')
const { isPrivateURL } = require('../ssrf')

const oembedLimiter = rateLimit({
    windowMs: 60000,
    max: 20,
    message: { error: 'too many requests' }
})

module.exports = {
    init: (app) => {
        app.get('/oembed/:url', oembedLimiter, async (req, res) => {
            const url = req.params.url
            if (!url) {
                res.sendStatus(500)
                return
            }
            // Only http(s) URLs are accepted. The user-supplied URL is passed to
            // oembed-parser, which never fetches it: it is matched against the
            // bundled provider list and then forwarded as a `?url=` query
            // parameter to the provider's hard-coded oEmbed endpoint. Pinning or
            // rewriting the URL here would break provider matching (and thus the
            // endpoint), so the check stays on the raw URL to reject internal /
            // non-routable targets.
            if (!/^https?:\/\//i.test(url) || await isPrivateURL(url)) {
                res.status(400).send({error: 'invalid url'})
                return
            }
            extract(url).then((data) => {
                res.send(data)
            }).catch(() => {
                res.sendStatus(404)
            })
        })
    }
}
