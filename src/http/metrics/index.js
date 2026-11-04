// == Prometheus metrics endpoint ==
// GET /metrics — text exposition format (Prometheus 0.0.4), per-node.
// Read-only, no secrets. Scrape it with Prometheus / VictoriaMetrics and alert
// from there; scripts/avalon-watch.js remains the lightweight Discord notifier.

const rateLimit = require('express-rate-limit')
const leaderHealth = require('../../leaderHealth')
const events = require('../../events')
const pkg = require('../../../package.json')

// Prometheus scrapes are not user traffic; keep a generous dedicated limit so a
// busy node never rate-limits its own monitoring.
const metricsLimiter = rateLimit({
    windowMs: 1000,
    max: 200,
    message: { error: 'too many metrics requests' }
})

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

module.exports = {
    init: (app) => {
        app.get('/metrics', metricsLimiter, (req, res) => {
            const lines = []
            const help = (name, type, text) => {
                lines.push('# HELP ' + name + ' ' + text)
                lines.push('# TYPE ' + name + ' ' + type)
            }
            const gauge = (name, value, labels) => {
                const l = labels
                    ? '{' + Object.keys(labels).map(k => k + '="' + esc(labels[k]) + '"').join(',') + '}'
                    : ''
                lines.push(name + l + ' ' + Number(value))
            }

            let latest = null
            try { latest = chain.getLatestBlock() } catch (e) { /* startup */ }
            const height = latest && Number.isInteger(latest._id) ? latest._id : -1

            help('avalon_height', 'gauge', 'Current chain head height (-1 = unknown).')
            gauge('avalon_height', height)

            help('avalon_uptime_seconds', 'gauge', 'Process uptime in seconds.')
            gauge('avalon_uptime_seconds', Math.floor(process.uptime()))

            help('avalon_version_info', 'gauge', 'Always 1; the version is a label (for joins).')
            gauge('avalon_version_info', 1, { version: pkg.version })

            let peers = -1
            try { peers = (p2p && p2p.sockets) ? p2p.sockets.length : -1 } catch (e) {}
            help('avalon_peers', 'gauge', 'Connected P2P peers.')
            gauge('avalon_peers', peers)

            // Consensus view. Guard everything: /metrics must never throw.
            let active = []
            let eligible = []
            let quorum = -1
            let poss = -1
            let queue = -1
            let recovering = 0
            try {
                const next = height + 1
                active = consensus.activeLeaders ? consensus.activeLeaders() : []
                eligible = consensus.eligibleLeaders ? consensus.eligibleLeaders(next) : active
                quorum = consensus._getQuorumThreshold ? consensus._getQuorumThreshold() : -1
                poss = consensus.possBlocks ? consensus.possBlocks.length : -1
                queue = consensus.queue ? consensus.queue.length : -1
                recovering = consensus.recovering ? 1 : 0
            } catch (e) { /* leave defaults */ }

            help('avalon_active_leaders', 'gauge', 'Size of the active leader set for the next height.')
            gauge('avalon_active_leaders', active.length)
            help('avalon_eligible_leaders', 'gauge', 'Size of the quorum-eligible leader set.')
            gauge('avalon_eligible_leaders', eligible.length)
            help('avalon_quorum_threshold', 'gauge', 'Votes required to finalise (block consensus / force-finalize).')
            gauge('avalon_quorum_threshold', quorum)
            help('avalon_poss_blocks', 'gauge', 'Candidate blocks currently queued for consensus (backlog indicator).')
            gauge('avalon_poss_blocks', poss)
            help('avalon_queue_size', 'gauge', 'Buffered P2P/consensus messages waiting to be processed.')
            gauge('avalon_queue_size', queue)
            help('avalon_recovering', 'gauge', '1 while the node is catching up from a peer, else 0.')
            gauge('avalon_recovering', recovering)

            const flags = {
                force_finalize: !!config.forceFinalize,
                skip_recording: !!config.skipRecording,
                skip_strict: !!config.skipStrict,
                halt_breaker: !!config.haltBreaker && process.env.HALT_BREAKER !== '0',
                standby_enabled: !!config.standbyEnabled,
                canonical_leader_order: !!config.canonicalLeaderOrder,
                single_vote: !!(consensus && consensus.singleVoteEnabled)
            }
            help('avalon_flag', 'gauge', 'Effective runtime consensus flag (1/0), labelled by name.')
            for (const k of Object.keys(flags)) gauge('avalon_flag', flags[k] ? 1 : 0, { name: k })

            // Per-leader health.
            let snapshot = {}
            try { snapshot = leaderHealth.snapshot ? leaderHealth.snapshot(height + 1) : {} } catch (e) {}
            help('avalon_leader_jailed', 'gauge', '1 if the leader is soft-jailed at the current height.')
            help('avalon_leader_streak', 'gauge', 'Consecutive proven missed turns.')
            help('avalon_leader_produced_total', 'counter', 'Blocks produced by this leader (rebuilt view).')
            help('avalon_leader_missed_total', 'counter', 'Turns proven missed by this leader (rebuilt view).')
            for (const name of Object.keys(snapshot).sort()) {
                const l = snapshot[name] || {}
                gauge('avalon_leader_jailed', l.jailed ? 1 : 0, { leader: name })
                gauge('avalon_leader_streak', l.streak || 0, { leader: name })
                gauge('avalon_leader_produced_total', l.produced || 0, { leader: name })
                gauge('avalon_leader_missed_total', l.missed || 0, { leader: name })
            }

            // Structured events (GET /events). Counters + last-occurrence time let
            // an alert rule catch rare state changes (halt breaker, force finalize,
            // jail, recovery) instead of polling the endpoint.
            try {
                const snap = events.snapshot()
                help('avalon_events_head', 'gauge', 'Last structured-event sequence number.')
                gauge('avalon_events_head', snap.head)
                help('avalon_event_total', 'counter', 'Structured events emitted since start, by type.')
                help('avalon_last_event_timestamp_seconds', 'gauge', 'Unix time of the most recent event, by type.')
                for (const type of Object.keys(snap.counters).sort()) {
                    gauge('avalon_event_total', snap.counters[type], { type: type })
                    if (snap.lastTs[type]) gauge('avalon_last_event_timestamp_seconds', Math.floor(snap.lastTs[type] / 1000), { type: type })
                }
            } catch (e) { /* events must never break metrics */ }

            res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
            res.send(lines.join('\n') + '\n')
        })
    }
}
