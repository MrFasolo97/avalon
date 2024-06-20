module.exports = {
    init: (app) => {
        // list connected leader peers
        app.get('/leaderPeers', (req, res) => {
            res.send(p2p.pbft.peers)
        })
    }
}
