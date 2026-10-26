// /leaderhealth — read-only view of the offline-leader state machine.
//
// Prototype diagnostics endpoint for doc/consensus-offline-leaders-plan.en.md:
// everything it prints is derived from the chain (plus the in-memory schedule of
// the current epoch), so two nodes at the same height must print the same values
// for ladder / jailed / quorum.
module.exports = {
    init: (app) => {
        app.get('/leaderhealth', (req, res) => {
            const tip = chain.getLatestBlock()
            const schedule = chain.schedule || {}
            const height = tip._id
            const state = chain.jailState(height)
            const quorum = consensus.leaderQuorum()
            const health = chain.healthParams(height)

            const jailed = []
            const streaks = {}
            Object.keys(state.byName || {}).forEach(name => {
                const e = state.byName[name]
                if (e.jailedUntil && e.jailedUntil > height)
                    jailed.push({ name, until: e.jailedUntil, jails: e.jailCount })
                if (e.streak) streaks[name] = e.streak
            })

            res.send({
                node: process.env.NODE_OWNER,
                height,
                tip: {
                    id: height,
                    miner: tip.miner,
                    timestamp: tip.timestamp,
                    missedBy: tip.missedBy || null,
                    skips: tip.skips || [],
                },
                params: {
                    leaders: health.leaders,
                    leaderStandbys: health.leaderStandbys,
                    jailMissThreshold: health.jailMissThreshold,
                    jailBlocks: health.jailBlocks,
                    quorumMin: health.quorumMin,
                    quorumCap: health.quorumCap,
                    H_S: config.H_S,
                    H_strict: config.H_strict,
                    H_standby: config.H_standby,
                    skipStrict: health.skipStrict,
                    standbyEnabled: health.standbyEnabled,
                    jailEnabled: health.jailEnabled,
                    bootstrap: health.bootstrap,
                    haltBreakerMs: config.haltBreakerMs,
                },
                schedule: {
                    epochBlock: schedule.block ? schedule.block._id : null,
                    shuffle: (schedule.shuffle || []).map(s => s && s.name),
                    standby: (schedule.standby || []).map(s => s && s.name),
                    activeSet: schedule.activeSet || [],
                },
                ladder: chain.leaderLadder(height + 1),
                jailed,
                streaks,
                quorum: {
                    eligible: quorum.eligible,
                    E: quorum.E,
                    q: quorum.q,
                },
                breaker: consensus.breaker,
                commitLock: {
                    enabled: !!config.commitLock,
                    locks: consensus.commitLocks,
                    refusals: consensus.lockRefusals || 0,
                    overrides: consensus.lockOverrides || 0,
                },
            })
        })
    }
}
