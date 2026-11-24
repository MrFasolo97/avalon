// == Transferable vote proof (fork choice) ==
//
// A chain is "proven" when we can show QUORUM distinct eligible signers emitted
// a signed COMMIT (t:6, round 1) for the same (height, hash). COMMIT is the
// finality phase: PRECOMMIT is only a round-0 poll and two competing blocks at
// the same height can gather precommit quorums in different rounds. A rollback
// must therefore never be justified by PRECOMMITs.
//
// Those votes are already on the wire; this module only verifies them. It has
// no I/O and no globals, so the fork-choice decision is unit-testable and
// replayable.
//
// Block bodies do not carry votes. Proof travels in NODE_STATUS.headVoteProof
// (see p2p.js) and is verified against the eligible set and quorum of the
// proof's own height (the contested height for the competing block), never
// against the local head's adaptive eligibility.

const consensusQuorum = require('./consensusQuorum')

const PRECOMMIT = consensusQuorum.PRECOMMIT
const COMMIT = consensusQuorum.COMMIT

// Verify a set of signed compact COMMIT votes. `opts`:
//   verifySignature(message, cb)  required, synchronous callback verifier
//   eligible                      array of eligible signer names (or a Set)
//   quorum                        minimum distinct valid signers
// Returns { valid, count, quorum, signers, reasons }.
function verifyProof(proof, opts) {
    const reasons = []
    if (!proof || !Number.isInteger(proof.height) || proof.height < 0) reasons.push('bad height')
    if (typeof proof.hash !== 'string' || !proof.hash) reasons.push('bad hash')
    if (!Array.isArray(proof.votes) || proof.votes.length === 0) reasons.push('no votes')

    const eligible = opts && opts.eligible instanceof Set
        ? opts.eligible
        : new Set((opts && Array.isArray(opts.eligible) ? opts.eligible : []).map(n => n && n.name ? n.name : n))
    const quorum = opts && Number.isFinite(opts.quorum) ? opts.quorum
        : consensusQuorum.blockQuorum(eligible.size, 3)

    const signers = new Set()
    if (proof && Array.isArray(proof.votes))
        for (const vote of proof.votes) {
            if (!vote || vote.t !== 6 || !vote.d || !vote.s) { reasons.push('bad vote shape'); continue }
            // Finality is the COMMIT phase. A proof containing a PRECOMMIT is
            // not a finality proof, even if enough COMMITs are also present.
            if (vote.d.r !== COMMIT) { reasons.push('not a commit'); continue }
            if (vote.d.h !== proof.height) { reasons.push('wrong height'); continue }
            if (!vote.d.b || vote.d.b.hash !== proof.hash) { reasons.push('wrong hash'); continue }
            if (typeof vote.s.n !== 'string' || typeof vote.s.s !== 'string') { reasons.push('bad signature fields'); continue }
            if (!eligible.has(vote.s.n) || signers.has(vote.s.n)) { reasons.push('ineligible or duplicate signer'); continue }
            if (typeof opts.verifySignature !== 'function') { reasons.push('no verifier'); continue }
            let ok = false
            try { opts.verifySignature(vote, (v) => { ok = v === true }) } catch (e) { ok = false }
            if (!ok) { reasons.push('invalid signature'); continue }
            signers.add(vote.s.n)
        }

    return {
        valid: reasons.length === 0 && Number.isFinite(quorum) && signers.size >= quorum,
        count: signers.size,
        quorum: quorum,
        signers: Array.from(signers).sort(),
        reasons: reasons
    }
}

// A chain is stronger only when it carries finality and the incumbent does not.
//
// Once a block has a valid COMMIT quorum it is final: height is not a fork-choice
// rule between two finalized blocks, because two different finalized hashes at
// any heights are a safety violation (quorum intersection under INV-1), not a
// branch to follow. A local head with a valid COMMIT proof therefore can never
// be replaced by a peer proof, no matter how much higher the peer claims to be.
function stronger(candidate, incumbent) {
    if (!candidate || candidate.valid !== true) return false
    if (!incumbent || incumbent.valid !== true) return true
    return false
}

module.exports = { verifyProof, stronger, PRECOMMIT, COMMIT }
