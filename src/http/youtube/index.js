const YT = require('simple-youtube-api')

module.exports = {
    init: (app) => {
        if (!process.env.YT_API_KEY) {
            app.get('/youtube/:videoId', (req, res) => res.status(501).send({error: 'youtube API not configured'}))
            return
        }
        const yt = new YT(process.env.YT_API_KEY)
        app.get('/youtube/:videoId', (req, res) => {
            if (!req.params.videoId) {
                res.sendStatus(500)
                return
            }
            yt.getVideoByID(req.params.videoId).then(function (video) {
                video.duration = video.durationSeconds
                res.send(video)
            }).catch(function (err) {
                logr.warn('YouTube API error', err)
                res.sendStatus(500)
            })
        })
    }
}