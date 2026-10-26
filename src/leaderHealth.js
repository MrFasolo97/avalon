// leaderHealth.js — offline / unresponsive leader handling (prototype kernel)
//
// Companion code for doc/consensus-offline-leaders-plan.en.md.
//
// Everything in this file is a *pure* function of data that is already in the chain
// (the block window) plus the consensus parameters. No timers, no local liveness
// probes, no node-local state: two nodes with the same blocks always compute the
// same ladders, the same skip attestations, the same jail state and the same quorum.
//
// Layer S (soft fork): `skips[]` attestation, absence accounting, adaptive quorum.
// Layer H (height gated): standbys promoted into the rotation.
//
// NOTE (prototype): the jail state is rebuilt from a bounded window of recent blocks
// (`lookback`). A jail that started before the window is approximated as "not jailed";
// the production implementation keeps a checkpointed jail index instead (plan §6.2).

const DEFAULTS = {
    leaders: 5,
    leaderStandbys: 5,
    jailMissThreshold: 30,
    jailBlocks: 200,
    jailBackoffMax: 4, // re-jail durations J * 2^k, capped at this factor
    quorumMin: 3,
    quorumCap: 4,
    heartbeatTxType: 18, // ENABLE_NODE, re-sent as a heartbeat
    lookback: 5000,
    standbyEnabled: false,
}

function params(overrides = {}) {
    const p = Object.assign({}, DEFAULTS)
    for (const k of Object.keys(DEFAULTS)) {
        const v = overrides[k]
        if (v === undefined || v === null) continue
        if (typeof DEFAULTS[k] === 'number' && typeof v !== 'number') {
            const n = parseInt(v, 10)
            if (!isNaN(n)) p[k] = n
            continue
        }
        p[k] = v
    }
    return p
}

// --- canonical ordering (fixes F6: ties must not depend on mongodb natural order) ---

function compareCandidates(a, b) {
    const d = (b.node_appr || 0) - (a.node_appr || 0)
    if (d !== 0) return d
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
}

// candidates: [{ name, node_appr, pub_leader, ... }] already filtered for eligibility
function rankCandidates(candidates, overrides) {
    const p = params(overrides)
    const valid = (candidates || []).filter(c => c && typeof c.name === 'string' && (c.node_appr || 0) > 0)
    const sorted = valid.slice().sort(compareCandidates)
    return {
        all: sorted,
        active: sorted.slice(0, p.leaders),
        standby: sorted.slice(p.leaders, p.leaders + p.leaderStandbys),
    }
}

// Deterministic shuffle of an epoch, same NRNG as chain.minerSchedule
function shuffleEpoch(candidates, hash, precision) {
    const prec = precision || 6
    let rand = parseInt('0x' + String(hash || '').substr(-prec), 16)
    if (isNaN(rand)) rand = 0
    const pool = (candidates || []).slice()
    const out = []
    while (pool.length > 0) {
        const i = rand % pool.length
        out.push(pool[i])
        pool.splice(i, 1)
    }
    return out
}

// --- the turn ladder (plan §3.1) ---

// Ladder for `height`: [ scheduled, miner(h-1), miner(h-2), ..., standbys... ]
//   shuffle:  the (possibly padded) epoch schedule, array of { name }
//   recentBlocks: ascending block history, the tip is the parent of `height`
function ladderFor(height, opts = {}) {
    const p = params(opts)
    const shuffle = opts.shuffle || []
    const recentBlocks = opts.recentBlocks || []
    const names = []
    const add = (n) => {
        if (typeof n !== 'string' || !n) return
        if (names.indexOf(n) === -1) names.push(n)
    }

    if (shuffle.length > 0) {
        const slot = shuffle[(height - 1) % p.leaders]
        if (slot) add(slot.name)
    }

    // backups: most recent producers first (p = 1, 2, ...), same window as the
    // priority rule the chain already enforced (i < 2*leaders)
    for (let i = 1; i < 2 * p.leaders; i++) {
        const b = recentBlocks[recentBlocks.length - i]
        if (!b) break
        add(b.miner)
    }

    // Layer H: standbys may produce after everybody above them
    if (p.standbyEnabled)
        for (const s of (opts.standbys || [])) add(typeof s === 'string' ? s : s && s.name)

    return names
}

function positionOf(ladder, name) {
    return (ladder || []).indexOf(name)
}

function canonicalSkips(ladder, position) {
    return position > 0 ? ladder.slice(0, position) : []
}

function skipList(block) {
    if (!block) return []
    if (Array.isArray(block.skips)) return block.skips.slice()
    // legacy compatibility: a block without skips[] still carries missedBy
    if (typeof block.missedBy === 'string' && block.missedBy) return [block.missedBy]
    return []
}

function sameSkips(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i]) return false
    return true
}

// Attestation check for a block against the canonical ladder (plan §5.3)
function attestation(block, ladder) {
    const p = positionOf(ladder, block && block.miner)
    const got = skipList(block)
    if (p === -1) return { ok: false, reason: 'miner-not-in-ladder', position: p, expected: null, got }
    const expected = canonicalSkips(ladder, p)
    return {
        ok: sameSkips(expected, got),
        reason: sameSkips(expected, got) ? null : 'skips-mismatch',
        position: p,
        expected,
        got,
    }
}

// --- absence accounting + soft jail (plan §6.1/§6.2) ---

// Deterministic forward replay over the last `lookback` blocks.
// Returns { byName: { name: { streak, jailCount, jailedUntil } }, tip, height }
//   streak        consecutive proven misses since the last production / heartbeat
//   jailedUntil   block height at which the jail expires (0 = not jailed)
//   jailCount     number of jails in the window, used for the backoff
function jailState(blocks, overrides) {
    const p = params(overrides)
    const list = blocks || []
    const from = Math.max(0, list.length - p.lookback)
    const byName = {}
    const entry = (n) => {
        if (!byName[n]) byName[n] = { streak: 0, jailCount: 0, jailedUntil: 0 }
        return byName[n]
    }
    let tip = 0
    let tipTs = 0

    for (let i = from; i < list.length; i++) {
        const b = list[i]
        if (!b) continue
        tip = b._id
        tipTs = b.timestamp

        // a leader that produced a block is alive: reset its absence and expire a jail
        if (typeof b.miner === 'string') {
            const e = entry(b.miner)
            e.streak = 0
            if (e.jailedUntil && b._id >= e.jailedUntil) e.jailedUntil = 0
        }

        // wake-up: ENABLE_NODE (type 18) re-sent with the current leader key
        // is idempotent, costs no fee and clears the jail immediately (plan §7)
        for (const tx of (b.txs || [])) {
            if (tx && tx.type === p.heartbeatTxType && typeof tx.sender === 'string') {
                const e = entry(tx.sender)
                e.streak = 0
                e.jailedUntil = 0
            }
        }

        // proven skips recorded by the producer of this block
        for (const n of skipList(b)) {
            if (typeof n !== 'string' || !n) continue
            const e = entry(n)
            if (e.jailedUntil) {
                if (b._id >= e.jailedUntil) e.jailedUntil = 0 // expired, back in rotation
                else continue // jailed leaders are not scheduled: no new misses
            }
            e.streak += 1
            if (e.streak >= p.jailMissThreshold) {
                const factor = Math.pow(2, Math.min(e.jailCount, Math.max(0, Math.round(Math.log2(p.jailBackoffMax)))))
                e.jailedUntil = b._id + p.jailBlocks * factor
                e.jailCount += 1
                e.streak = 0 // fresh start when the jail expires
            }
        }
    }

    return { byName, tip, height: tip, timestamp: tipTs }
}

function stateOf(state, name) {
    if (!state || !state.byName) return { streak: 0, jailCount: 0, jailedUntil: 0 }
    return state.byName[name] || { streak: 0, jailCount: 0, jailedUntil: 0 }
}

function isJailed(state, name, height) {
    const e = stateOf(state, name)
    return !!e.jailedUntil && (height === undefined ? true : e.jailedUntil > height)
}

// --- adaptive quorum (plan §6.3) ---

// quorumEligibility = 'lastTurn': a leader whose most recent scheduled turn was
// demonstrably skipped on-chain leaves the denominator (no timer involved).
function eligibleLeaders(leaderNames, state, height) {
    const out = []
    for (const n of (leaderNames || [])) {
        if (out.indexOf(n) !== -1) continue
        if (isJailed(state, n, height)) continue
        if (stateOf(state, n).streak > 0) continue
        out.push(n)
    }
    return out
}

// q = min(cap, max(quorumMin, E))
function quorumSize(eligibleCount, overrides) {
    const p = params(overrides)
    return Math.min(p.quorumCap, Math.max(p.quorumMin, eligibleCount))
}

// Majority threshold for the halt breaker. Any two majorities of the same set
// intersect, so with a per-height commit lock a network partition cannot
// finalise two different blocks at the same height: the intersection node would
// have to commit both, which the lock forbids.
function breakerThreshold(eligibleCount) {
    if (eligibleCount <= 1) return eligibleCount
    return Math.floor(eligibleCount / 2) + 1
}

function quorumFor(leaderNames, state, height, overrides) {
    const p = params(overrides)
    const eligible = eligibleLeaders(leaderNames, state, height)
    return { eligible, E: eligible.length, q: quorumSize(eligible.length, p) }
}

// --- per-height commit lock (safety) ---
//
// Two valid blocks at the same height are produced by design: the scheduled leader
// and, after the skip grace, a substitute. Avalon resolves the collision by "earliest
// timestamp, then lowest hash", but the votes do not distinguish the two candidates:
// a node precommits (round 0) every valid one and, without a lock, commits (round 1)
// every one of them too. With q = E that is harmless only as long as every node sees
// the same candidates; under asymmetric visibility (partition, latency) each side can
// finalise a different block at the same height.
//
// The lock: a node commits at most one hash per height. `locks` is a plain map
// height -> { hash, miner }. The only escape hatch is an explicit haltBreaker
// recovery round, which may override the lock for that height because it is already
// the documented safety relaxation of the design; overrides are reported back so the
// caller can log and count them.
function commitDecision(locks, height, candidate, override) {
    const lock = (locks || {})[height]
    const hash = candidate && candidate.hash
    if (!hash) return { allow: false, reason: 'no-candidate', overridden: false, lock: false }
    if (!lock) return { allow: true, reason: 'unlocked', overridden: false, lock: true }
    if (lock.hash === hash) return { allow: true, reason: 'same-block', overridden: false, lock: false }
    if (override && override.height === height && override.hash === hash)
        return { allow: true, reason: 'breaker-override', overridden: true, lock: true }
    return {
        allow: false,
        reason: 'locked',
        overridden: false,
        lock: false,
        lockedHash: lock.hash,
        lockedMiner: lock.miner,
    }
}

module.exports = {
    DEFAULTS,
    params,
    compareCandidates,
    rankCandidates,
    shuffleEpoch,
    ladderFor,
    positionOf,
    canonicalSkips,
    skipList,
    sameSkips,
    attestation,
    jailState,
    stateOf,
    isJailed,
    eligibleLeaders,
    quorumSize,
    quorumFor,
    commitDecision,
    breakerThreshold,
}
