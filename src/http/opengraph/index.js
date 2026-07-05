const ogs = require('open-graph-scraper')
const { URL } = require('url')
const dns = require('dns').promises
const net = require('net')
const fetch = require('node-fetch-commonjs')

async function isPrivateURL(urlStr) {
    try {
        const parsed = new URL(urlStr)
        const host = parsed.hostname
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]')
            return true

        let ip
        if (net.isIP(host)) {
            ip = host
        } else {
            try {
                const lookup = await dns.lookup(host, {family: 4})
                ip = lookup.address
            } catch {
                return true
            }
        }
        if (!ip) return false

        if (net.isIPv4(ip)) {
            const parts = ip.split('.').map(Number)
            if (parts[0] === 10) return true
            if (parts[0] === 127) return true
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
            if (parts[0] === 192 && parts[1] === 168) return true
            if (parts[0] === 169 && parts[1] === 254) return true
            if (parts[0] === 0) return true
        }

        if (net.isIPv6(ip)) {
            const lower = ip.toLowerCase()
            if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
            if (lower.startsWith('fd') || lower.startsWith('fc')) return true
            if (lower.startsWith('fe80')) return true
        }
        return false
    } catch {
        return true
    }
}

async function resolveSafeUrl(urlStr) {
    const maxRedirects = 5
    let currentUrl = urlStr
    for (let i = 0; i < maxRedirects; i++) {
        if (await isPrivateURL(currentUrl))
            throw new Error('blocked private URL')
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
            const resp = await fetch(currentUrl, { method: 'HEAD', signal: controller.signal, redirect: 'manual' })
            clearTimeout(timeout)
            if (resp.status >= 300 && resp.status < 400) {
                const location = resp.headers.get('location')
                if (!location) throw new Error('redirect with no location')
                currentUrl = new URL(location, currentUrl).href
                continue
            }
            return currentUrl
        } catch (e) {
            clearTimeout(timeout)
            throw e
        }
    }
    throw new Error('too many redirects')
}

module.exports = {
    init: (app) => {
        app.get('/opengraph/:url', async (req, res) => {
            if (!req.params.url) {
                res.sendStatus(500)
                return
            }
            try {
                const finalUrl = await resolveSafeUrl(req.params.url)
                ogs({ url: finalUrl, timeout: 5000, headers: { 'user-agent': 'facebookexternalhit/1.1 (+https://d.tube)' } }, function (error, results) {
                    if (error) res.sendStatus(404)
                    else res.send(results)
                })
            } catch {
                res.status(400).send({error: 'invalid url'})
            }
        })
    }
}
