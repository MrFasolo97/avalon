// == Consensus quorum + vote ledger (pure) ==
// Design: doc/consensus-single-quorum-and-locks.en.md
//
// No side effects, no globals, no chain access: the eligible set, the height,
// the phase and the hash are always passed in. That makes every rule here
// replayable from block data and unit-testable without a DB or a socket.
//
// Phases mirror config.consensusRounds (0 = precommit, 1 = commit).

const PRECOMMIT = 0
const COMMIT = 1

// The single quorum definition of the codebase: the smallest integer strictly
// above 2/3 of n. Fails closed for n <= 0 (Infinity: nothing satisfies it).
function quorumSize(n) {
    if (!Number.isInteger(n) || n <= 0) return Infinity
    return Math.floor((2 * n) / 3) + 1
}

// Quorum used to finalise a BLOCK on a leader set of n signers.
//
// Historically consensus.js asked for `max(floor(2n/3)+1, 3)`: a floor of 3 to
// stop a 50% partition from finalising alone. On a 1- or 2-node network that
// floor is unreachable (asking 3 votes of 1 signer), which stalls the chain
// instead of protecting it — exactly what blocked the docker testnet at
// block 0. Capping the floor by n keeps the intent for n >= 3, and for n < 3
// the formula is already strictly above n/2 (1 of 1, 2 of 2), so two disjoint
// groups still cannot both finalise.
// `minQuorum` is config.quorumMin (the approved floor, 3): the absolute minimum
// number of signers, capped by n so it never asks for more votes than exist.
// Defaults to 3, which reproduces the historical `max(floor(2n/3)+1, min(3, n))`.
function blockQuorum(n, minQuorum) {
    if (!Number.isInteger(n) || n <= 0) return 3 // unreachable: fail closed
    const floor = Number.isInteger(minQuorum) && minQuorum > 0 ? minQuorum : 3
    return Math.max(quorumSize(n), Math.min(floor, n))
}

// Pre-fix formula from consensus.js `_getQuorumThreshold` (L413-419).
// Kept ONLY so tests can prove the two formulas diverge, and stop doing so.
function legacyForceFinalizeQuorum(activeCount, configLeaders) {
    const configThreshold = Math.ceil((configLeaders * 2) / 3)
    const activeThreshold = Math.ceil((activeCount * 2) / 3)
    return Math.min(configThreshold, Math.max(activeThreshold, 3))
}

// Canonical, order-independent eligible set. Every node must derive the same
// array from the same block data, or the quorum denominators differ per node.
function canonicalEligible(names) {
    const seen = new Set()
    for (const name of names)
        if (typeof name === 'string' && name.length > 0) seen.add(name)
    return Array.from(seen).sort()
}

function isPhase(r) {
    return r === PRECOMMIT || r === COMMIT
}

function voteKey(h, r) {
    return h + ':' + r
}

function createLedger(options) {
    return {
        // singleVote = one vote per (height, phase) per signer, ENFORCED (INV-1).
        // The shadow observer turns it off to mirror Avalon's multi-candidate
        // voting: there the same checks are only counted, never applied.
        singleVote: !options || options.singleVote !== false,
        votes: new Map(), // "h:r" -> Map(hash -> Set(signer))
        locks: new Map(), // height -> hash this node precommitted
        equivocations: [] // { h, r, signer, hash, previousHash }
    }
}

function hashVotes(ledger, h, r) {
    let byHash = ledger.votes.get(voteKey(h, r))
    if (!byHash) {
        byHash = new Map()
        ledger.votes.set(voteKey(h, r), byHash)
    }
    return byHash
}

function signersForHash(ledger, h, r, hash) {
    const byHash = ledger.votes.get(voteKey(h, r))
    const set = byHash && byHash.get(hash)
    return set ? set : new Set()
}

function signerVotedFor(ledger, h, r, signer) {
    const byHash = ledger.votes.get(voteKey(h, r))
    if (!byHash) return null
    for (const [hash, set] of byHash)
        if (set.has(signer)) return hash
    return null
}

// Record one vote. Returns { accepted, reason, count }. Idempotent for an
// exact duplicate (same signer, same height/phase/hash).
//
// `singleVote` (INV-1, the default) ENFORCES one hash per (height, phase) per
// signer: a conflicting vote is refused. With `singleVote: false` the same
// checks are only REPORTED (`reason` is `equivocation`/`lock-conflict` but the
// vote is still counted): that is what the shadow observer needs, because
// Avalon's protocol votes on every candidate block at a height, so enforcing
// INV-1 there would measure a rule the chain deliberately does not follow.
function recordVote(ledger, vote) {
    const { h, r, hash, signer } = vote || {}

    if (!Number.isInteger(h) || h < 0) return { accepted: false, reason: 'invalid-height' }
    if (!isPhase(r)) return { accepted: false, reason: 'invalid-phase' }
    if (typeof hash !== 'string' || hash.length === 0) return { accepted: false, reason: 'invalid-hash' }
    if (typeof signer !== 'string' || signer.length === 0) return { accepted: false, reason: 'invalid-signer' }

    const enforce = ledger.singleVote
    let conflict = null

    // Lock: after precommitting h#A, this node must not precommit h#A'.
    // Liveness is preserved because COMMIT votes are still allowed (see doc
    // §2.4): the lock forbids changing our own precommit, not observing one.
    if (r === PRECOMMIT && ledger.locks.has(h) && ledger.locks.get(h) !== hash) {
        conflict = { reason: 'lock-conflict', locked: ledger.locks.get(h) }
        if (enforce) return { accepted: false, reason: 'lock-conflict', locked: ledger.locks.get(h) }
    }

    const previous = signerVotedFor(ledger, h, r, signer)
    if (previous !== null && previous !== hash) {
        ledger.equivocations.push({ h, r, signer, hash, previousHash: previous })
        if (enforce) return { accepted: false, reason: 'equivocation', previous }
        conflict = conflict || { reason: 'equivocation', previous }
    }

    const byHash = hashVotes(ledger, h, r)
    let set = byHash.get(hash)
    if (!set) {
        set = new Set()
        byHash.set(hash, set)
    }
    const reason = conflict ? conflict.reason : 'counted'
    if (set.has(signer)) return { accepted: true, reason: 'duplicate', count: set.size }

    set.add(signer)
    if (r === PRECOMMIT && !ledger.locks.has(h)) ledger.locks.set(h, hash)

    return { accepted: true, reason, count: set.size, previous: conflict ? conflict.previous : undefined }
}

function lockedOn(ledger, h) {
    return ledger.locks.has(h) ? ledger.locks.get(h) : null
}

function canPrecommit(ledger, h, hash) {
    const lock = lockedOn(ledger, h)
    return lock === null || lock === hash
}

// QC = a quorum of DISTINCT eligible signers for the same (height, phase, hash).
// Signers outside the eligible set are ignored, never counted.
function hasQC(ledger, h, r, hash, eligible) {
    const q = quorumSize(eligible.length)
    if (!Number.isFinite(q)) return { qc: false, count: 0, quorum: q }

    const eligibleSet = new Set(eligible)
    let count = 0
    for (const signer of signersForHash(ledger, h, r, hash))
        if (eligibleSet.has(signer)) count++

    return { qc: count >= q, count, quorum: q }
}

// Hash with a QC at (h, r), or null. If two hashes somehow reach a QC here the
// ledger's single-vote invariant has been violated upstream: report it loudly
// instead of silently picking one.
function qcHash(ledger, h, r, eligible) {
    const byHash = ledger.votes.get(voteKey(h, r))
    if (!byHash) return { hash: null, conflict: false }
    let found = null
    let conflict = false
    for (const hash of byHash.keys()) {
        const res = hasQC(ledger, h, r, hash, eligible)
        if (!res.qc) continue
        if (found !== null && found !== hash) conflict = true
        if (found === null) found = hash
    }
    return { hash: found, conflict }
}

// Shadow-mode comparison between the production rule (a raw count against a
// locally computed threshold) and the ledger rule (distinct eligible signers
// against quorumSize). Reports what the two disagree about, without ever
// changing the production decision.
function compareDecision(input) {
    const { productionCount, threshold, ledger, h, r, hash, eligible } = input

    const production = Number.isFinite(threshold) && productionCount >= threshold
    const qc = hasQC(ledger, h, r, hash, eligible)

    return {
        productionFinalizes: production,
        qcFinalizes: qc.qc,
        productionCount,
        threshold,
        qcCount: qc.count,
        quorum: qc.quorum,
        divergence: production !== qc.qc,
        // the dangerous direction: production would finalise something the
        // ledger says does not have a quorum
        unsafe: production && !qc.qc,
        // the wasteful direction: a quorum exists but production ignores it
        late: !production && qc.qc
    }
}

// Drop vote/lock state for heights we can never vote on again. Keeps the
// ledger O(1) per height instead of growing with the chain.
function pruneLedger(ledger, belowHeight) {
    let dropped = 0
    for (const key of Array.from(ledger.votes.keys())) {
        const h = Number(key.split(':')[0])
        if (Number.isInteger(h) && h < belowHeight) {
            ledger.votes.delete(key)
            dropped++
        }
    }
    for (const h of Array.from(ledger.locks.keys()))
        if (h < belowHeight) {
            ledger.locks.delete(h)
            dropped++
        }
    return dropped
}

module.exports = {
    PRECOMMIT,
    COMMIT,
    quorumSize,
    blockQuorum,
    legacyForceFinalizeQuorum,
    canonicalEligible,
    createLedger,
    recordVote,
    lockedOn,
    canPrecommit,
    hasQC,
    qcHash,
    compareDecision,
    pruneLedger,
    signersForHash
}
