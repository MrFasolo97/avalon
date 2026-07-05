const { URL } = require('url')

module.exports = {
    init: (app) => {
        // connect to a new peer
        app.post('/addPeer', (req, res) => {
            const peer = req.body.peer
            if (!peer || typeof peer !== 'string')
                return res.status(400).send({error: 'invalid peer'})
            if (!peer.startsWith('ws://') && !peer.startsWith('wss://'))
                return res.status(400).send({error: 'invalid peer protocol'})
            try {
                const parsed = new URL(peer)
                if (parsed.hostname === 'localhost')
                    return res.status(400).send({error: 'local peer not allowed'})
            } catch {
                return res.status(400).send({error: 'invalid peer url'})
            }
            p2p.connect([peer])
            res.send()
        })
    }
}
