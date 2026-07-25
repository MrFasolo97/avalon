const { isPrivateURL, resolveAndPin, checkRebinding } = require('../ssrf')

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

                // Rebuild peer URL with the vetted IP to ensure we connect to the resolved address
                parsed.hostname = pinnedIp
                parsed.port = parsed.port || (parsed.protocol === 'wss:' ? 443 : 80)
                p2p.connect([parsed.toString()])
                res.send()
            } catch {
                return res.status(400).send({error: 'invalid peer url'})
            }
        })
    }
}
