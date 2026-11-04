// == Structured events endpoint ==
// GET /events?since=<seq>&limit=<n>&type=a,b — the in-process ring buffer
// (src/events.js). Read-only, no secrets. Polling clients pass `since` = the
// last `seq` they saw and only get new events.

const rateLimit = require('express-rate-limit')
const events = require('../../events')

const eventsLimiter = rateLimit({
    windowMs: 1000,
    max: 20,
    message: { error: 'too many events requests' }
})

module.exports = {
    init: (app) => {
        app.get('/events', eventsLimiter, (req, res) => {
            res.send({
                head: events.head(),
                events: events.list({
                    since: req.query.since,
                    limit: req.query.limit,
                    type: req.query.type
                })
            })
        })
    }
}
