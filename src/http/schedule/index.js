const leaderHealth = require('../../leaderHealth')

module.exports = {
    init: (app) => {
        /**
         * @api {get} /schedule Block Producer Schedule
         * @apiName schedule
         * @apiGroup Blockchain
         *
         * @apiSuccess {Object} block Block the current schedule was generated from
         * @apiSuccess {Array} shuffle Shuffled leader set in force for this epoch
         * @apiSuccess {Integer} epoch Start height of the current epoch
         * @apiSuccess {Array} set Active leader set (canonical order, Layer H)
         * @apiSuccess {Array} standbys Standby pool below the active cut (Layer H)
         * @apiSuccess {Array} jailed Leaders currently soft-jailed
         */
        // look at the miner schedule
        app.get('/schedule', (req, res) => {
            const head = chain.getLatestBlock()._id
            // Layer S/H additive fields: `shuffle` is untouched so existing
            // consumers keep working.
            const schedule = Object.assign({}, chain.schedule)
            schedule.epoch = head - (head % config.leaders)
            try {
                schedule.set = chain.activeLeaderSet ? chain.activeLeaderSet().map(l => l.name) : []
                schedule.standbys = chain.standbyLeaderSet ? chain.standbyLeaderSet().map(l => l.name) : []
            } catch (e) {
                logr.error('schedule set/standbys computation failed', e)
                schedule.set = []
                schedule.standbys = []
            }
            schedule.jailed = Object.keys(leaderHealth.leaders || {})
                .filter(name => leaderHealth.isJailed(name, head + 1))
            res.send(schedule)
        })
    }
}
