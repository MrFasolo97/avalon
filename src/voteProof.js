// == Transferable vote proof (fork choice) ==
//
// A chain is "proven" when we can show QUORUM distinct eligible signers emitted
// a signed PRECOMMIT (t:6, round 0) for the same (height, hash). Those votes are
// already on the wire; this module only verifies them. It has no I/O and no
// globals, so the fork-choice decision is unit-testable and replayable.
//
// Block bodies do not carry votes. Proof travels in NODE_STATUS.headVoteProof
// (see p2p.js) and is verified against the eligible set of the contested height.

const consensusQuorum = require('./consensusQuorum')

const PRECOMMIT = consensusQuorum.PRECOMMIT

// Verify a set of signed compact PRECOMMIT votes. `opts`:
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
            if (vote.d.r !== PRECOMMIT) { reasons.push('not a precommit'); continue }
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

// A chain is stronger when it is proven and either longer, or at equal height
// backed by more distinct signers. Hash is the deterministic final tie-break.
function stronger(candidate, incumbent) {
    if (!candidate || candidate.valid !== true) return false
    if (!incumbent || incumbent.valid !== true) return true
    if (candidate.height !== incumbent.height) return candidate.height > incumbent.height
    if (candidate.count !== incumbent.count) return candidate.count > incumbent.count
    return String(candidate.hash) < String(incumbent.hash)
}

module.exports = { verifyProof, stronger, PRECOMMIT }
