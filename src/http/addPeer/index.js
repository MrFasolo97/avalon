const { URL } = require('url')
const dns = require('dns/promises')
const net = require('net')
const { isPrivateURL, resolveAndPin, checkRebinding } = require('../ssrf')

async function isPrivateIP(ip) {
    return isPrivateURL('http://' + ip)
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

                const pinnedIp = await resolveAndPin(host)
                if (!pinnedIp)
                    return res.status(400).send({error: 'cannot resolve peer hostname'})

                if (!(await checkRebinding(host, pinnedIp)))
                    return res.status(400).send({error: 'dns rebinding detected'})

                if (await isPrivateURL('http://' + pinnedIp))
                    return res.status(400).send({error: 'private peer not allowed'})

                p2p.connect([peer])
                res.send()
            } catch {
                return res.status(400).send({error: 'invalid peer url'})
            }
        })
    }
}
