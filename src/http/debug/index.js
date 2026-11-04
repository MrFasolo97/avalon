const rateLimit = require('express-rate-limit')
const crypto = require('crypto')
const leaderHealth = require('../../leaderHealth')
const { requireAuth } = require('../auth')

const debugLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    message: { error: 'too many debug requests' }
})

// /debug/statehash is a read-only determinism probe polled by operators, the
// drill suite and cross-node comparison scripts. 5/min made it unusable (and
// made drills fail with an empty statehash that looked like a crash).
const stateHashLimiter = rateLimit({
    windowMs: 60000,
    max: 120,
    message: { error: 'too many statehash requests' }
})

module.exports = {
    init: (app) => {
        app.get('/debug', debugLimiter, requireAuth(), (req, res) => {
            res.send({
                consensus: {
                    height: chain.getLatestBlock()._id,
                    possBlocksCount: consensus.possBlocks.length,
                },
                chain: {
                    recentBlocksCount: chain.recentBlocks.length,
                    recentTxsCount: Object.keys(chain.recentTxs).length
                }
            })
        })

        // Deterministic state hash for cross-node divergence detection.
        // Excludes non-deterministic runtime state (timers, sockets) and
        // secrets. Includes head block, recent block hashes, poss blocks,
        // leader health and the current schedule — exactly the data that
        // causes forks if it diverges.
        app.get('/debug/statehash', stateHashLimiter, (req, res) => {
            const latest = chain.getLatestBlock()
            const nextHeight = latest._id + 1
            const active = consensus.activeLeaders ? consensus.activeLeaders() : []
            const eligible = consensus.eligibleLeaders ? consensus.eligibleLeaders(nextHeight) : active

            // leaderHealth has two kinds of fields: the consensus-relevant state
            // (streak, absent, lastScheduledTurn, jailed, …) which is derived from
            // the chain and MUST match on every node, and the cumulative counters
            // (produced, missed, lastProduced) which depend on how much history a
            // node rebuilt leaderHealth from at startup — a node restarted late
            // rebuilds over a shorter window and reports different totals. Only the
            // former can signal a fork, so hash a normalized view and sort the names
            // to keep the digest independent of object key order.
            const health = leaderHealth.snapshot ? leaderHealth.snapshot(nextHeight) : {}
            const normHealth = {}
            for (const name of Object.keys(health).sort()) {
                const l = health[name] || {}
                normHealth[name] = {
                    streak: l.streak,
                    absent: l.absent,
                    lastScheduledTurn: l.lastScheduledTurn,
                    jailed: l.jailed,
                    jailUntil: l.jailUntil,
                    probation: l.probation
                }
            }

            const snapshot = {
                height: latest._id,
                headHash: latest.hash,
                headPhash: latest.phash,
                headTimestamp: latest.timestamp,
                miner: latest.miner,
                skips: latest.skips,
                recent: (chain.recentBlocks || []).slice(-20).map(b => ({
                    _id: b._id,
                    hash: b.hash,
                    miner: b.miner,
                    skips: b.skips
                })),
                // NOTE: consensus.possBlocks is deliberately NOT hashed. It is
                // transient gossip (which candidate blocks a node happens to have
                // received by now), so two healthy nodes legitimately differ while
                // a height is being decided — hashing it produced false
                // "divergence" alarms right after a partition heal. The durable
                // derived state below is what a fork would actually change.
                activeLeaders: active.slice().sort(),
                eligibleLeaders: eligible.slice().sort(),
                leaderHealth: normHealth,
                schedule: (chain.schedule && chain.schedule.shuffle)
                    ? chain.schedule.shuffle.map(s => s.name)
                    : []
            }

            const canonical = JSON.stringify(Object.keys(snapshot).sort().reduce((o, k) => {
                o[k] = snapshot[k]
                return o
            }, {}))

            res.send({
                height: latest._id,
                stateHash: crypto.createHash('sha256').update(canonical).digest('hex'),
                inputs: snapshot
            })
        })
    }
}
