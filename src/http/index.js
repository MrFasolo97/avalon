const http_port = process.env.HTTP_PORT || 3001
const http_host = process.env.HTTP_HOST || '127.0.0.1'
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const rateLimit = require('express-rate-limit')
const fs = require('fs')

const globalLimiter = rateLimit({
    windowMs: 1000,
    max: 50,
    message: { error: 'too many requests' }
})

// Express accepts a hop count (number), a boolean, or a keyword / IP-list
// string; anything else is parsed as an IP by proxy-addr and throws a cryptic
// "invalid IP address" at startup, killing the node before it listens.
// Normalise the common spellings here so e.g. TRUST_PROXY=true fails with a
// clear message instead.
// "Trust every proxy" (express's boolean `true`) is deliberately refused: it
// makes X-Forwarded-For spoofable, which defeats the rate limiting and the
// session address binding that rely on req.ip.
function parseTrustProxy(raw) {
    if (raw === undefined || raw === null) return undefined
    const v = String(raw).trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off') return undefined
    if (/^\d+$/.test(v)) return parseInt(v, 10)
    if (v === 'loopback' || v === 'linklocal' || v === 'uniquelocal') return v
    if (v === 'true' || v === 'yes' || v === 'on')
        throw new Error("TRUST_PROXY: refusing '" + raw + "' (trusting every proxy makes " +
            "X-Forwarded-For spoofable); use a hop count (e.g. TRUST_PROXY=1) or loopback|linklocal|uniquelocal")
    return v
}

let http = {
    init: () => {
        let app = express()
        // Only honour X-Forwarded-* when explicitly told the node sits behind a
        // trusted proxy, otherwise req.ip (used for rate limiting and session
        // address binding) would be client-spoofable.
        try {
            const trustProxy = parseTrustProxy(process.env.TRUST_PROXY)
            if (trustProxy !== undefined)
                app.set('trust proxy', trustProxy)
        } catch (error) {
            logr.fatal(error.message)
            process.exit(1)
        }
        app.use(cors({
            origin: process.env.CORS_ORIGIN || false
        }))
        app.use(bodyParser.json({ limit: '1mb' }))
        app.use(globalLimiter)

        // any folder in the /http/ folder is a different api endpoint
        let endpoints = fs.readdirSync(__dirname, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
        for (let i = 0; i < endpoints.length; i++)
            try {
                require(__dirname+'/'+endpoints[i]).init(app)
                logr.debug('Initialized API endpoint /'+endpoints[i])
            } catch (error) {
                logr.error('Failed to load API endpoint /'+endpoints[i]+': '+error.message)
            }
            
        app.listen(http_port, http_host, () => logr.info('Listening http on port: ' + http_port))
    }
}

http.parseTrustProxy = parseTrustProxy
module.exports = http
