// == Automatic recovery from a CHAIN DIVERGENCE ==
//
// Forward-only recover() cannot heal a minority fork: the node keeps asking for
// blocks that do not extend its head. This module turns the F8 detection into a
// bounded, fail-closed reorg:
//
//   1. verify the competing chain's vote proof (src/voteProof.js);
//   2. find the common ancestor from the local block store;
//   3. truncate local blocks, restore the newest state snapshot at/below the
//      ancestor and replay only the retained canonical prefix from there;
//   4. hand the node back to the normal forward recover() path.
//
// No rollback happens without a valid quorum proof, a common ancestor and a
// bounded depth. All I/O is injected so the whole decision is unit-testable.

const voteProof = require('./voteProof')

// Reorg depth is CHAIN CONFIG, not a per-node env var: two nodes with different
// MAX_REORG_DEPTH values would make different rollback decisions on the same
// fork. `config.maxReorgDepth` is read at the contested height by p2p.js and
// passed in as `input.maxReorg`; this is the conservative fallback for tests.
const DEFAULT_MAX_REORG = 10

const configuredMaxReorg = () => {
    const n = typeof config !== 'undefined' && config ? config.maxReorgDepth : null
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_REORG
}

let divergence = {
    lastProposal: null,
    rollbacks: 0,

    // Pure fork choice. Returns null, or a decision object describing the peer
    // whose proven chain must be adopted.
    evaluate: (input) => {
        if (!input || !input.local || !Array.isArray(input.peers)) return null
        const verify = input.verifySignature
        if (typeof verify !== 'function') return null

        // Resolve the eligible set and quorum PER PROOF HEIGHT. p2p.js supplies
        // height-aware resolvers so a fork proof is never checked against the
        // local head's adaptive eligibility. Flat input.eligible/quorum remains
        // supported for unit tests and simple callers.
        const contexts = new Map()
        const contextAt = (height) => {
            if (contexts.has(height)) return contexts.get(height)
            let eligible = input.eligibleAt ? input.eligibleAt(height) : input.eligible
            eligible = eligible || []
            const quorum = input.quorumAt
                ? input.quorumAt(height, eligible)
                : (input.quorum !== undefined ? input.quorum : undefined)
            const context = { eligible, quorum }
            contexts.set(height, context)
            return context
        }

        const local = input.local
        const localProof = Array.isArray(local.proof)
            ? { height: local.height, hash: local.hash, votes: local.proof }
            : Object.assign({ height: local.height, hash: local.hash }, local.proof || {})
        const localCtx = contextAt(local.height)
        const localScore = Object.assign({ height: local.height, hash: local.hash },
            voteProof.verifyProof(localProof, { verifySignature: verify,
                eligible: localCtx.eligible, quorum: localCtx.quorum }))

        let best = null
        for (const peer of input.peers) {
            if (!peer || !Number.isInteger(peer.height)) continue
            const hash = peer.hash || peer.headHash
            if (typeof hash !== 'string' || !hash) continue
            if (peer.height < local.height || hash === local.hash) continue
            if (Number.isInteger(input.contestedHeight) && peer.height < input.contestedHeight) continue
            // Peers publish `headVoteProof` as a bare array of signed votes, so
            // wrap it with the claimed (height, hash) before verification. The
            // proof's votes must carry that same explicit height and hash.
            const peerProof = Array.isArray(peer.proof)
                ? { height: peer.height, hash: hash, votes: peer.proof }
                : Object.assign({ height: peer.height, hash: hash }, peer.proof || {})
            const peerCtx = contextAt(peer.height)
            const score = Object.assign({ height: peer.height, hash: hash },
                voteProof.verifyProof(peerProof, { verifySignature: verify,
                    eligible: peerCtx.eligible, quorum: peerCtx.quorum }))
            if (!score.valid) continue
            if (voteProof.stronger(score, localScore)
            && (!best || voteProof.stronger(score, best))) best = score
        }
        if (!best) return null

        divergence.lastProposal = best
        return {
            shouldRollback: true,
            height: best.height,
            hash: best.hash,
            proof: best.proof || null,
            signers: best.signers,
            ancestor: null
        }
    },

    // Walk back from the contested height until the local hash matches the
    // parent hash carried by the proven block. Fail closed when no common
    // ancestor exists inside the bound.
    //
    // A fetched block can now be applied to our chain by another (serialized)
    // caller before its duplicate reaches us. Before walking back we therefore
    // require the local block at the contested height to EXIST and to carry a
    // DIFFERENT hash: an identical hash is a duplicate delivery, not a fork, and
    // must never be used as evidence for a rollback.
    findAncestor: (input) => {
        const height = input && input.height
        let phash = input && input.phash
        const localHashAt = input && input.localHashAt
        if (!Number.isInteger(height) || height < 1) return null
        if (typeof phash !== 'string' || !phash) return null
        if (typeof localHashAt !== 'function') return null
        if (typeof input.hash === 'string' && input.hash) {
            let contestedHash = null
            try { contestedHash = localHashAt(height) } catch (e) { return null }
            if (!contestedHash || contestedHash === input.hash) return null
        }
        const maxDepth = Number.isInteger(input.maxReorg) && input.maxReorg > 0
            ? input.maxReorg : configuredMaxReorg()
        for (let h = height - 1, depth = 1; h >= 0 && depth <= maxDepth; h--, depth++) {
            let localHash = null
            try { localHash = localHashAt(h) } catch (e) { return null }
            if (localHash === phash) return h
            // Walk down the COMPETING chain when the caller supplies its parent
            // hashes; otherwise only the immediate parent of the conflict is
            // comparable and a deeper fork fails closed.
            if (typeof input.competingParentAt === 'function' && h - 1 >= 0) {
                const next = input.competingParentAt(h - 1)
                if (typeof next === 'string' && next) phash = next
            }
        }
        return null
    },

    // Execute the rollback. Every destructive step is injected; a failure at
    // any step rejects and p2p.js keeps the node in recovery mode.
    rollback: (decision, deps) => {
        return new Promise((resolve, reject) => {
            if (!decision || decision.shouldRollback !== true
            || !Number.isInteger(decision.ancestor) || decision.ancestor < 0)
                return reject(new Error('refusing rollback without a valid decision and ancestor'))
            const io = deps || {}
            const logr = io.logr || (typeof global !== 'undefined' ? global.logr : null)
            const events = io.events
            const emit = (name, level, payload) => {
                if (events && typeof events.emit === 'function') events.emit(name, level, payload)
            }
            const step = (name, fn) => new Promise((rs, rj) => {
                try {
                    const out = fn()
                    if (out && typeof out.then === 'function') out.then(rs, rj)
                    else rs(out)
                } catch (e) { rj(e) }
            })

            const run = async () => {
                emit('chain-rollback-start', 'warn', {
                    head: decision.fromHeight, ancestor: decision.ancestor,
                    target: decision.height, targetHash: decision.hash,
                    signers: decision.signers
                })
                if (logr && logr.warn) logr.warn('CHAIN ROLLBACK: local head ' + decision.fromHeight
                    + ' -> ancestor #' + decision.ancestor + ' (syncing to proven #'
                    + decision.height + '#' + String(decision.hash).substr(0, 8) + ')')

                // Check this BEFORE truncating anything: without a snapshot at or
                // below the ancestor there is no safe way to rebuild the state.
                await step('preflight-snapshot', () => {
                    if (!io.hasSnapshot) return true
                    return Promise.resolve(io.hasSnapshot(decision.ancestor)).then(ok => {
                        if (!ok) throw new Error('no usable state snapshot at or below ancestor '
                            + decision.ancestor)
                    })
                })
                await step('pause-mining', () => {
                    if (io.pause) return io.pause()
                })
                await step('truncate-blocks', () => {
                    if (!io.truncateBlocks) throw new Error('no block truncation primitive')
                    return io.truncateBlocks(decision.ancestor)
                })
                await step('reset-state', () => {
                    if (!io.resetState) throw new Error('no state reset primitive')
                    return io.resetState(decision.ancestor)
                })
                await step('reset-runtime', () => {
                    if (io.resetRuntime) return io.resetRuntime(decision.ancestor)
                })
                await step('rebuild-state', () => {
                    if (!io.rebuildState) throw new Error('no state rebuild primitive')
                    return io.rebuildState(decision.ancestor)
                })
                await step('resume', () => {
                    if (io.resume) return io.resume(decision.ancestor)
                })

                divergence.rollbacks++
                emit('chain-rollback', 'info', {
                    head: decision.ancestor, target: decision.height,
                    targetHash: decision.hash, signers: decision.signers
                })
                if (logr && logr.info) logr.info('CHAIN ROLLBACK complete at #' + decision.ancestor
                    + '; forward recovery will sync to #' + decision.height)
                resolve(decision)
            }
            run().catch(reject)
        })
    }
}

module.exports = divergence
