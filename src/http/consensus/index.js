// == Consensus state endpoint (Layer S/H) ==
// Read-only introspection for operators and testnet drills.
// No secrets, no private keys, no write paths.

const rateLimit = require('express-rate-limit')
const leaderHealth = require('../../leaderHealth')

const consensusLimiter = rateLimit({
    windowMs: 1000,
    max: 10,
    message: { error: 'too many consensus requests' }
})

module.exports = {
    init: (app) => {
        app.get('/consensus', consensusLimiter, (req, res) => {
            const latest = chain.getLatestBlock()
            const nextHeight = latest._id + 1
            const active = consensus.activeLeaders ? consensus.activeLeaders() : []
            const eligible = consensus.eligibleLeaders ? consensus.eligibleLeaders(nextHeight) : active
            const threshold = consensus._getQuorumThreshold ? consensus._getQuorumThreshold() : null

            const possBlocks = (consensus.possBlocks || []).map(pb => ({
                _id: pb.block._id,
                hash: pb.block.hash,
                miner: pb.block.miner,
                timestamp: pb.block.timestamp,
                skips: pb.block.skips,
                rounds: Object.keys(pb)
                    .filter(k => /^\d+$/.test(k))
                    .map(k => ({ round: parseInt(k), signers: pb[k] }))
            }))

            res.send({
                node: process.env.NODE_OWNER,
                observer: consensus.observer,
                height: latest._id,
                headHash: latest.hash,
                nextHeight: nextHeight,
                blockTime: config.blockTime,
                activeLeaders: active,
                eligibleLeaders: eligible,
                eligibleCount: eligible.length,
                quorumThreshold: threshold,
                possBlocksCount: consensus.possBlocks ? consensus.possBlocks.length : 0,
                possBlocks: possBlocks,
                queueSize: consensus.queue ? consensus.queue.length : 0,
                leaderHealth: leaderHealth.snapshot ? leaderHealth.snapshot(nextHeight) : {},
                schedule: {
                    blockHeight: latest._id,
                    epochStart: latest._id - (latest._id % config.leaders),
                    shuffle: (chain.schedule && chain.schedule.shuffle) || []
                },
                flags: {
                    forceFinalize: !!config.forceFinalize,
                    skipRecording: !!config.skipRecording,
                    skipStrict: !!config.skipStrict,
                    // effective value: the breaker can also be disabled per node
                    // with HALT_BREAKER=0 (consensus.runHaltBreaker honours it), so
                    // report what is actually in force, not just the config entry.
                    haltBreaker: !!config.haltBreaker && process.env.HALT_BREAKER !== '0',
                    standbyEnabled: !!config.standbyEnabled,
                    canonicalLeaderOrder: !!config.canonicalLeaderOrder,
                    // S1' single-vote enforcement (opt-in via CONSENSUS_SINGLE_VOTE=1)
                    singleVote: !!consensus.singleVoteEnabled
                }
            })
        })
    }
}
