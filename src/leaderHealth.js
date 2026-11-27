// == Leader health / skip accounting (Layer S/H) ==
// Design: doc/consensus-offline-leaders-plan.en.md
//
// This module is pure derived state: it folds over finalised blocks and rebuilds
// from `chain.recentBlocks`. It never mutates accounts, balances, stake or keys.
//
// Layer S (soft fork):
//   - tracks produced/missed turns and lastScheduledTurn
//   - provides eligible(h) for the adaptive quorum
// Layer H (hard fork):
//   - tracks jail state, streaks, probation, backoff
//   - handles heartbeat (ENABLE_NODE type 18) wake-up

const events = require('./events')

const leaderHealth = {
    leaders: {},

    // H1: jail thresholds must be read from the configuration in force AT THE
    // BLOCK HEIGHT, not from the mutable global config (which reflects the head
    // and can differ between a fresh node and one replaying history).
    configAt: (h) => (typeof config.read === 'function' ? config.read(h) : config),

    // H1: single chain-data activation gate for the whole jail state machine.
    // Derived from config.history, so no env var, wall clock or local build can
    // enable the rule earlier on one node than on another.
    jailActivationHeight: () => {
        if (typeof config.activationHeight === 'function')
            return config.activationHeight('jailEnabled')
        if (typeof config.jailActivationHeight === 'number')
            return config.jailActivationHeight
        return 0 // legacy unit-test stubs: pre-gate behaviour
    },
    jailActiveAt: (h) => Number.isFinite(h) && h >= leaderHealth.jailActivationHeight(),

    emptyLeader: () => ({
        produced: 0,
        missed: 0,
        streak: 0,          // consecutive proven missed scheduled turns
        absent: false,      // its most recent scheduled turn was skipped
        lastProduced: -1,   // last height where this leader mined
        lastScheduledTurn: -1, // last height where S(h) == name (produced or skipped)
        lastSkip: null,     // { height, position }
        jail: null          // { active, untilBlock, level, lastJailBlock, probation }
    }),

    get: (name) => {
        if (!leaderHealth.leaders[name])
            leaderHealth.leaders[name] = leaderHealth.emptyLeader()
        return leaderHealth.leaders[name]
    },

    // Record that `name` produced block `h`.
    recordProduced: (name, h) => {
        const l = leaderHealth.get(name)
        l.produced += 1
        l.lastProduced = h
        // producing proves the node is online: it is eligible again
        l.absent = false
        l.streak = 0
        // A productive probation ends in ACTIVE (design §6.2: PROBATION --produces-->
        // ACTIVE). Re-jailing here would strand a healthy node that just came back
        // and — worse — jail any leader whose account received a plain ENABLE_NODE
        // (which arms probation), collapsing the whole rotation.
        if (l.jail && l.jail.probation)
            l.jail = {
                active: false,
                untilBlock: -1,
                level: 0,
                lastJailBlock: l.jail.lastJailBlock,
                probation: false
            }
    },

    // Record that `name` was skipped at height `h` at ladder position `position`.
    recordSkip: (name, h, position) => {
        const l = leaderHealth.get(name)
        l.missed += 1
        l.lastSkip = { height: h, position: position }
        // only scheduled turns (position 0) count toward streak/jail and
        // eligibility; backup skips are evidence of absence but not turns
        if (position === 0) {
            l.streak += 1
            // lastTurn(X) has been demonstrably skipped: X leaves the eligible
            // set (adaptive quorum, plan §6.3) until it produces again.
            l.absent = true
            leaderHealth.maybeJail(name, h)
        }
    },

    maybeJail: (name, h) => {
        if (!leaderHealth.jailActiveAt(h)) return
        const c = leaderHealth.configAt(h)
        const threshold = c.jailMissThreshold || 30
        const l = leaderHealth.get(name)
        if (l.streak < threshold) return
        if (l.jail && l.jail.active) return
        const base = c.jailBlocks || 200
        const level = l.jail ? Math.min((l.jail.level || 0) + 1, c.jailBackoffMax || 4) : 1
        const duration = base * Math.pow(2, level - 1)
        l.jail = {
            active: true,
            untilBlock: h + duration,
            level: level,
            lastJailBlock: h,
            probation: false
        }
        events.emit('leader-jailed', 'warn', {
            leader: name, height: h, untilBlock: l.jail.untilBlock, level: level, streak: l.streak
        })
    },

    reJail: (name, h) => {
        if (!leaderHealth.jailActiveAt(h)) return
        const c = leaderHealth.configAt(h)
        const base = c.jailBlocks || 200
        const l = leaderHealth.get(name)
        const level = l.jail ? Math.min((l.jail.level || 0) + 1, c.jailBackoffMax || 4) : 1
        const duration = base * Math.pow(2, level - 1)
        l.jail = {
            active: true,
            untilBlock: h + duration,
            level: level,
            lastJailBlock: h,
            probation: false
        }
        events.emit('leader-rejailed', 'warn', {
            leader: name, height: h, untilBlock: l.jail.untilBlock, level: level
        })
    },

    // Heartbeat: a type-18 tx from the account clears jail immediately.
    // H1: gated by block height, not by node-local time/state.
    heartbeat: (name, h) => {
        if (!leaderHealth.jailActiveAt(h)) return
        const l = leaderHealth.get(name)
        l.streak = 0
        l.absent = false
        // Only an account that was ACTUALLY jailed comes back under probation.
        // A plain ENABLE_NODE (the setup sends one per leader, and operators
        // re-send it as a heartbeat) must be a no-op for a healthy leader: arming
        // probation here made every leader re-jail itself on its first block,
        // collapsing the rotation down to the standbys.
        if (!l.jail || !l.jail.active) return
        l.jail = {
            active: false,
            untilBlock: -1,
            level: 0,
            lastJailBlock: l.jail.lastJailBlock,
            probation: true
        }
        events.emit('leader-unjailed', 'info', { leader: name, via: 'heartbeat' })
    },

    isJailed: (name, h) => {
        if (!leaderHealth.jailActiveAt(h)) return false
        const l = leaderHealth.leaders[name]
        if (!l || !l.jail || !l.jail.active) return false
        return l.jail.untilBlock > h
    },

    // A leader is eligible for the quorum denominator at height `h` iff it has
    // had a scheduled turn in the CURRENT epoch and that most recent turn was
    // NOT demonstrably skipped (plan §6.3: absent(X) = miner(lastTurn(X)) ≠ X).
    // Layer H: additionally excludes jailed leaders.
    isEligible: (name, h) => {
        const l = leaderHealth.leaders[name]
        if (!l) return false
        if (leaderHealth.isJailed(name, h)) return false
        // If the leader was never scheduled, it is not eligible.
        if (l.lastScheduledTurn < 0) return false
        if (!l.absent) return true
        // Its most recent turn was taken by a backup: drop it from the
        // denominator so the remaining leaders can still reach quorum.
        //
        // Absence is scoped to the epoch of that turn. A new epoch gives every
        // leader a fresh turn, so waiting for it is meaningful again — keeping
        // it out until it produces would let a single outage shrink the quorum
        // to the one node that happens to have produced last (observed on the
        // drills: E collapsed to 1 and nothing could be certified).
        const leaders = leaderHealth.configAt(h).leaders
        if (!leaders || leaders <= 0) return true
        const epochOf = (height) => Math.floor((height - 1) / leaders)
        return epochOf(l.lastScheduledTurn) !== epochOf(h)
    },

    // Process one finalised block. `schedule` is the epoch schedule in force at
    // the block's height (must be passed in by the caller). When it is not
    // available (startup rebuild over a bounded window) the scheduled leader is
    // recovered from the block itself, which is exactly equivalent:
    //   - a backup block attests it in skips[0] (ladder position 0),
    //   - a scheduled block has miner === S(h) and no skips.
    processBlock: (block, schedule, cfg) => {
        if (!block) throw new Error('leaderHealth.processBlock: block required')
        const h = block._id
        const c = cfg || leaderHealth.configAt(h)
        // H1: before the chain-data activation height there is NO jail/absence
        // state on any node. A restarted node and a node that never restarted
        // therefore start from the identical empty state, regardless of their
        // build, env vars or how far back their rebuild window reaches.
        if (!leaderHealth.jailActiveAt(h)) return
        const skips = Array.isArray(block.skips) ? block.skips
            : (block.missedBy ? [block.missedBy] : [])

        // Mark the scheduled leader's turn, even if the block was produced by a backup.
        // The block-derived fallback is canonical for Layer S/H blocks (skips[0]
        // is S(h) when a backup produced, miner is S(h) otherwise).
        let scheduledName = null
        if (schedule && schedule.shuffle && c.leaders) {
            const scheduled = schedule.shuffle[(h - 1) % c.leaders]
            if (scheduled && scheduled.name) scheduledName = scheduled.name
        }
        if (!scheduledName)
            scheduledName = skips.length ? skips[0] : block.miner
        if (scheduledName)
            leaderHealth.get(scheduledName).lastScheduledTurn = h

        leaderHealth.recordProduced(block.miner, h)
        for (let i = 0; i < skips.length; i++)
            leaderHealth.recordSkip(skips[i], h, i)

        // Heartbeat: type 18 from the account clears jail (Layer H).
        for (let i = 0; i < block.txs.length; i++) {
            const tx = block.txs[i]
            if (tx && tx.type === 18 && tx.sender)
                leaderHealth.heartbeat(tx.sender, h)
        }

        // Auto-expire jail at block boundary. `active` must be cleared as well:
        // isJailed() already returns false past untilBlock, but maybeJail()
        // checks jail.active and would otherwise refuse to ever re-jail this
        // leader (it stays in probation until it produces, which it cannot do
        // while absent from the rotation).
        for (const name in leaderHealth.leaders)
            if (leaderHealth.leaders[name].jail
            && leaderHealth.leaders[name].jail.active
            && leaderHealth.leaders[name].jail.untilBlock <= h) {
                leaderHealth.leaders[name].jail.active = false
                leaderHealth.leaders[name].jail.probation = true
            }
    },

    // Rebuild from an array of blocks (used at startup / rebuildState).
    rebuild: (blocks, scheduleFn) => {
        leaderHealth.leaders = {}
        if (!Array.isArray(blocks)) return
        for (const block of blocks) {
            const sched = typeof scheduleFn === 'function' ? scheduleFn(block) : null
            leaderHealth.processBlock(block, sched)
        }
    },

    // == R5: persisted jail checkpoint ==
    // Jail/absence/backoff are DERIVED state, but re-folding every block since
    // 13,325,000 on every restart is O(history) and grows without bound. We keep
    // a single Mongo document with the fully folded state plus the height it
    // represents. Startup then folds only `lastProcessedHeight + 1 .. head`.
    //
    // The checkpoint lives in its own collection which is part of state
    // snapshots (R8/R9): a rollback restores the checkpoint at/below the common
    // ancestor together with the rest of derived state, so the replay that
    // follows starts from an already-correct jail state. It is NOT the rollback
    // marker collection and is safe to copy/swap.
    checkpointCollection: 'jailCheckpoint',
    checkpointId: 0,

    // Deep-copy helpers so callers/tests cannot mutate the live fold by holding
    // a reference to the persisted object.
    serialize: (height) => ({
        _id: leaderHealth.checkpointId,
        lastProcessedHeight: height,
        leaders: JSON.parse(JSON.stringify(leaderHealth.leaders))
    }),
    restore: (doc) => {
        leaderHealth.leaders = (doc && doc.leaders)
            ? JSON.parse(JSON.stringify(doc.leaders)) : {}
        return doc && Number.isInteger(doc.lastProcessedHeight) ? doc.lastProcessedHeight : null
    },

    // Persist the checkpoint. Uses the explicit `height` argument rather than
    // chain.getLatestBlock() (the in-memory head is advanced only after the
    // matching state flush). Best-effort: a checkpoint write failure must never
    // fail block application — a restart simply replays a longer tail.
    persistCheckpoint: (height, database) => {
        const dbRef = database || (typeof db !== 'undefined' ? db : null)
        if (!dbRef || !Number.isInteger(height)) return Promise.resolve(false)
        try {
            const col = dbRef.collection(leaderHealth.checkpointCollection)
            if (!col) return Promise.resolve(false)
            return Promise.resolve(col.replaceOne(
                { _id: leaderHealth.checkpointId },
                leaderHealth.serialize(height),
                { upsert: true }
            )).then(() => true).catch(() => false)
        } catch (e) {
            return Promise.resolve(false)
        }
    },

    loadCheckpoint: (database) => {
        const dbRef = database || (typeof db !== 'undefined' ? db : null)
        if (!dbRef) return Promise.resolve(null)
        try {
            const col = dbRef.collection(leaderHealth.checkpointCollection)
            if (!col || !col.findOne) return Promise.resolve(null)
            return Promise.resolve(col.findOne({ _id: leaderHealth.checkpointId }))
                .then(doc => doc || null).catch(() => null)
        } catch (e) {
            return Promise.resolve(null)
        }
    },

    // Snapshot for /consensus and /debug/statehash.
    snapshot: (h) => {
        const out = {}
        for (const name in leaderHealth.leaders) {
            const l = leaderHealth.leaders[name]
            out[name] = {
                produced: l.produced,
                missed: l.missed,
                streak: l.streak,
                absent: l.absent,
                lastProduced: l.lastProduced,
                lastScheduledTurn: l.lastScheduledTurn,
                jailed: leaderHealth.isJailed(name, h),
                jailUntil: l.jail ? l.jail.untilBlock : -1,
                probation: l.jail ? l.jail.probation : false
            }
        }
        return out
    }
}

module.exports = leaderHealth
