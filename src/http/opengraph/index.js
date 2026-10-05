const ogs = require('open-graph-scraper')
const { URL } = require('url')
const net = require('net')
const http = require('http')
const https = require('https')
const tls = require('tls')
const fetch = require('node-fetch-commonjs')
const rateLimit = require('express-rate-limit')
const { isPrivateURL, isPrivateIP, resolveAndPin } = require('../ssrf')

const ogLimiter = rateLimit({
    windowMs: 60000,
    max: 20,
    message: { error: 'too many requests' }
})

const MAX_REDIRECTS = 5
const TIMEOUT = 5000

// got (used internally by open-graph-scraper) requires the agent to be an object
// keyed by protocol. Both agents dial the already-validated IP while keeping the
// original hostname for the Host header and TLS SNI, so certificate validation
// keeps working (rewriting the URL host to the IP would break every HTTPS site).
function pinnedAgents(pinnedIp, hostname) {
    return {
        http: new http.Agent({ createConnection: (opts, cb) => {
            opts.host = pinnedIp
            return net.createConnection(opts, cb)
        } }),
        https: new https.Agent({ createConnection: (opts, cb) => {
            opts.host = pinnedIp
            // SNI/cert validation must still see the real hostname
            opts.servername = hostname
            return tls.connect(opts, cb)
        } })
    }
}

// Walks the redirect chain manually so every hop is validated and IP-pinned,
// then hands the final URL to ogs with followRedirect:false. Without that flag
// the scraper could chase a redirect our validation never saw (e.g. a
// UA-dependent 302 to http://169.254.169.254/ that only appears on a re-request).
// Returns { url, agent } ready to be passed to ogs.
async function resolveSafeTarget(urlStr) {
    let currentUrl = urlStr
    let lastAgent = null
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
        if (await isPrivateURL(currentUrl))
            throw new Error('blocked private URL')
        const parsed = new URL(currentUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            throw new Error('blocked protocol')
        const pinnedIp = await resolveAndPin(parsed.hostname)
        if (!pinnedIp) throw new Error('could not resolve host')
        if (isPrivateIP(pinnedIp)) throw new Error('blocked private URL')
        const agents = pinnedAgents(pinnedIp, parsed.hostname)
        lastAgent = agents

        // node-fetch takes a single agent; got (inside ogs) takes the
        // {http,https} object. Hence both shapes are kept.
        const singleAgent = parsed.protocol === 'https:' ? agents.https : agents.http
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), TIMEOUT)
        let resp
        try {
            resp = await fetch(currentUrl, {
                signal: controller.signal,
                redirect: 'manual',
                agent: singleAgent,
                headers: { 'user-agent': 'facebookexternalhit/1.1 (+https://d.tube)' }
            })
        } finally {
            clearTimeout(timeout)
        }

        if (resp.status >= 300 && resp.status < 400) {
            if (i === MAX_REDIRECTS) throw new Error('too many redirects')
            const location = resp.headers.get('location')
            if (!location) throw new Error('redirect with no location')
            currentUrl = new URL(location, currentUrl).href
            continue
        }
        return { url: currentUrl, agent: lastAgent }
    }
    throw new Error('too many redirects')
}

module.exports = {
    init: (app) => {
        app.get('/opengraph/:url', ogLimiter, async (req, res) => {
            if (!req.params.url) {
                res.sendStatus(500)
                return
            }
            try {
                const target = await resolveSafeTarget(req.params.url)
                ogs({
                    url: target.url,
                    agent: target.agent,
                    timeout: TIMEOUT,
                    followRedirect: false,
                    headers: { 'user-agent': 'facebookexternalhit/1.1 (+https://d.tube)' }
                }, function (error, results) {
                    if (error) res.sendStatus(404)
                    else res.send(results)
                })
            } catch {
                res.status(400).send({error: 'invalid url'})
            }
        })
    }
}
