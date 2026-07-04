const { extract } = require('oembed-parser')
const { URL } = require('url')
const dns = require('dns')
const net = require('net')

function isPrivateURL(urlStr) {
    try {
        const parsed = new URL(urlStr)
        const host = parsed.hostname
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]')
            return true

        let ip
        if (net.isIP(host)) {
            ip = host
        } else {
            ip = dns.lookupSync(host, {family: 4})
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

module.exports = {
    init: (app) => {
        // get oembed for any url
        /**
         * @api {get} /oembed/:url OEmbed
         * @apiName oembed
         * @apiGroup External
         * 
         * @apiParam {String} url The URL to query oembed data of
         * 
         * @apiSuccess {Object} info The oembed data
         */
        app.get('/oembed/:url', (req, res) => {
            if (!req.params.url) {
                res.sendStatus(500)
                return
            }
            if (isPrivateURL(req.params.url)) {
                res.status(400).send({error: 'invalid url'})
                return
            }
            extract(req.params.url).then((data) => {
                res.send(data)
            }).catch(() => {
                res.sendStatus(404)
            })
        })
    }
}
