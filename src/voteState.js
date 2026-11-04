// == Vote state — single-vote across restarts ==
// Design: doc/consensus-single-quorum-and-locks.en.md §2.7
//
// The ledger that enforces "one vote per (height, phase)" is in RAM; a restart
// would erase it and reopen the equivocation window. This module persists the
// minimal voting record BEFORE the vote is broadcast, atomically, and offers
// the same decision function the ledger uses so a restart cannot disagree with
// a running instance.
//
// Not chain data: never hashed, never in a block, never in the state hash.

const fs = require('fs')
const path = require('path')

function emptyRecord() {
    return { height: -1, round: -1, hash: null, ts: 0 }
}

function normalize(raw) {
    const rec = emptyRecord()
    if (!raw || typeof raw !== 'object') return rec
    if (Number.isInteger(raw.height) && raw.height >= 0) rec.height = raw.height
    if (Number.isInteger(raw.round) && raw.round >= 0) rec.round = raw.round
    if (typeof raw.hash === 'string' && raw.hash.length > 0) rec.hash = raw.hash
    if (Number.isFinite(raw.ts)) rec.ts = raw.ts
    return rec
}

// Returns { record, corrupt, present }. A corrupt/unreadable file is NOT
// silently treated as "no vote yet" by callers that enforce: they check
// `corrupt` and fail closed (a node that cannot prove its last vote must not
// vote again at that height).
function load(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw)
        return { record: normalize(parsed), corrupt: false, present: true }
    } catch (e) {
        if (e && e.code === 'ENOENT') return { record: emptyRecord(), corrupt: false, present: false }
        return { record: emptyRecord(), corrupt: true, present: false }
    }
}

// Atomic write: temp file in the same directory, then rename. Throws on
// failure so the caller can refuse to broadcast.
function save(file, record) {
    const rec = normalize(record)
    rec.ts = Date.now()
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n')
    fs.renameSync(tmp, file)
    return rec
}

// Re-read/re-write to keep the record symmetric (the temp file is gone after
// a successful rename; a leftover temp means a crash between write and rename).
function saveVerified(file, record) {
    const written = save(file, record)
    const back = load(file)
    if (back.corrupt || back.record.height !== written.height || back.record.hash !== written.hash)
        throw new Error('vote state verification failed for ' + file)
    return written
}

// INV-1 across restarts. `next` = { height, round, hash }.
// Rollbacks/resyncs that legitimately move the head backwards must call
// reset() explicitly — never infer it here.
function decide(prev, next) {
    if (!next || !Number.isInteger(next.height) || !Number.isInteger(next.round))
        return { allow: false, reason: 'invalid-next' }

    const p = normalize(prev)
    if (p.height < 0) return { allow: true, reason: 'first-vote' }
    if (next.height > p.height) return { allow: true, reason: 'new-height' }
    if (next.height < p.height) return { allow: false, reason: 'stale-height' }
    if (next.round > p.round) return { allow: true, reason: 'next-phase' }
    if (next.round < p.round) return { allow: false, reason: 'stale-phase' }
    if (next.hash === p.hash) return { allow: true, reason: 'duplicate' }
    return { allow: false, reason: 'equivocation' }
}

function reset(file) {
    try {
        fs.unlinkSync(file)
        return true
    } catch (e) {
        return e && e.code === 'ENOENT'
    }
}

module.exports = {
    emptyRecord,
    normalize,
    load,
    save,
    saveVerified,
    decide,
    reset
}
