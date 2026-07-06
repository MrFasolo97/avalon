const { URL } = require('url')
const dns = require('dns').promises
const net = require('net')

function isPrivateIP(ip) {
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
}

module.exports = {
    init: (app) => {
        // connect to a new peer
        app.post('/addPeer', async (req, res) => {
            try {
                const peer = req.body.peer
                if (!peer || typeof peer !== 'string')
                    return res.status(400).send({error: 'invalid peer'})
                if (!peer.startsWith('ws://') && !peer.startsWith('wss://'))
                    return res.status(400).send({error: 'invalid peer protocol'})

                const parsed = new URL(peer)
                let host = parsed.hostname

                let ip
                if (net.isIP(host)) {
                    ip = host
                } else {
                    try {
                        const controller = new AbortController()
                        const timeout = setTimeout(() => controller.abort(), 5000)
                        try {
                            const lookup = await dns.lookup(host, {family: 4, signal: controller.signal})
                            ip = lookup.address
                        } finally {
                            clearTimeout(timeout)
                        }
                    } catch {
                        return res.status(400).send({error: 'cannot resolve peer hostname'})
                    }
                }

                if (isPrivateIP(ip))
                    return res.status(400).send({error: 'private peer not allowed'})

                p2p.connect([peer])
                res.send()
            } catch {
                return res.status(400).send({error: 'invalid peer url'})
            }
        })
    }
}
