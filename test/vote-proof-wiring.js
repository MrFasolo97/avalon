// == Transferable vote proof wiring ==
// node test/vote-proof-wiring.js
//
// The proof used for fork choice must be produced by the REAL consensus path,
// with QC_SHADOW off (the shipped default). A signed COMMIT (finality phase)
// with an explicit height is required: PRECOMMIT is not evidence of finality.

const assert = require('assert')
const consensusQuorum = require('../src/consensusQuorum')
const voteProof = require('../src/voteProof')

const COMMIT = consensusQuorum.COMMIT
const ladder = ['l1', 'l2', 'l3', 'l4', 'l5']
const h = 42
const hash = 'block-hash-42'
const broadcast = []

global.config = {
    b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
    leaders: 5, consensusRounds: 2, consensusSigVersion: 2, blockTime: 3000,
    quorumMin: 3, singleVote: true, qcEnforce: false,
    forceFinalize: false, forceFinalizeFallback: false, read: () => global.config
}
global.chain = {
    getLatestBlock: () => ({ _id: h - 1, hash: 'head' }),
    roundFor: () => 0,
    validateAndAddBlock: () => {}
}
global.logr = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, cons: () => {}, fatal: () => {}, econ: () => {} }
global.p2p = { broadcast: (m) => broadcast.push(m), recordBlockFailure: () => {} }
process.env.NODE_OWNER = 'l1'

const consensus = require('../src/consensus')
consensus.eligibleLeaders = () => ladder.slice()
consensus.isActive = () => true
consensus.castVote = () => true // isolate signing/proof retention from the quorum gate
consensus.tryNextStep = () => {}
// Fake signer: real crypto is irrelevant here, only message shape matters.
consensus.signMessage = (m) => Object.assign({}, m, { s: { n: 'l1', s: 'sig:l1', v: 2 } })

let passed = 0
let failed = 0
function test(name, fn) {
    try {
        fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        failed++
    }
}

console.log('=== Transferable vote proof wiring ===\n')

test('COMMIT broadcast with QC off carries height and verifies as a proof', () => {
    consensus.voteLedger = consensusQuorum.createLedger({ singleVote: true })
    consensus.possBlocks = [{ block: { _id: h, hash }, 0: [], 1: [] }]
    consensus.resetVoteProofs()
    broadcast.length = 0

    consensus.endRound(COMMIT, { _id: h, hash, miner: 'l2', timestamp: 1000 })
    assert.strictEqual(broadcast.length, 1)
    const msg = broadcast[0]
    assert.strictEqual(msg.t, 6)
    assert.strictEqual(msg.d.r, COMMIT)
    assert.strictEqual(msg.d.h, h, 'signed COMMIT must carry the explicit height')
    assert.strictEqual(msg.d.b.hash, hash)

    const proof = consensus.getVoteProof(h, hash)
    assert.strictEqual(proof.length, 1, 'the signed COMMIT must be retained for NODE_STATUS')

    const result = voteProof.verifyProof({ height: h, hash, votes: proof }, {
        verifySignature: (m, cb) => cb(String(m.s.s).startsWith('sig:' + m.s.n)),
        eligible: ladder, quorum: 1
    })
    assert.strictEqual(result.valid, true)
    assert.deepStrictEqual(result.signers, ['l1'])
})

test('PRECOMMIT votes are not retained as fork proofs', () => {
    consensus.resetVoteProofs()
    consensus.possBlocks = [{ block: { _id: h, hash }, 0: [], 1: [] }]
    consensus.endRound(consensusQuorum.PRECOMMIT, { _id: h, hash, miner: 'l2', timestamp: 1000 })
    assert.strictEqual(consensus.getVoteProof(h, hash).length, 0)
})

test('remote signed COMMITs are retained even when QC_SHADOW is off', () => {
    consensus.resetVoteProofs()
    consensus.possBlocks = [{ block: { _id: h, hash }, 0: [], 1: [] }]
    const remote = {
        t: 6, d: { r: COMMIT, b: { hash }, ts: 1000, h },
        s: { n: 'l2', s: 'sig:l2', v: 2 }
    }
    consensus.remoteRoundConfirm(remote)
    assert.strictEqual(consensus.getVoteProof(h, hash).length, 1)
    assert.strictEqual(consensus.getVoteProof(h, hash)[0].s.n, 'l2')
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
