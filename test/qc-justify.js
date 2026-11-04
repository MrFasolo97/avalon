// == QC on the wire: `h` + `justify` (doc §2.5) ==
// node test/qc-justify.js
//
// A round-1 (commit) vote can carry the round-0 QC as `justify`, so a peer that
// missed round 0 can still verify that a quorum existed. These assertions cover
// retention (compact hash-only votes only), the happy path with real signatures,
// the tamper path, and the eligibility filter.

process.env.QC_SHADOW = '1'
process.env.NODE_OWNER = 'l1'

const assert = require('assert')
const crypto = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')

function genPriv() {
    let priv = crypto.randomBytes(32)
    while (!secp256k1.privateKeyVerify(priv))
        priv = crypto.randomBytes(32)
    return priv
}

const NAMES = ['l1', 'l2', 'l3', 'l4', 'l5']
const keys = {}
for (const n of NAMES) keys[n] = genPriv()

global.config = {
    b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
    leaders: 5,
    consensusRounds: 2,
    consensusSigVersion: 2,
    blockTime: 3000,
    maxDrift: 200,
    forceFinalize: false,
    forceFinalizeFallback: false,
    quorumEligibility: 'activeLeaders',
    read: () => global.config
}
global.chain = {
    schedule: { shuffle: NAMES.map(n => ({ name: n, pub_leader: bs58.encode(secp256k1.publicKeyCreate(keys[n])) })) },
    recentBlocks: [],
    getLatestBlock: () => ({ _id: 0, hash: 'genesis' })
}
global.p2p = { broadcast: () => {}, recordBlockFailure: () => {} }
global.logr = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, cons: () => {}, fatal: () => {}, econ: () => {} }
global.cache = { rollback: () => {} }
global.dao = { resetID: () => {} }
global.daoMaster = { resetID: () => {} }

process.env.NODE_OWNER_PRIV = bs58.encode(keys.l1)

const consensus = require('../src/consensus')
consensus.qcEligible = () => NAMES.slice()

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

function reset() {
    consensus.qc.qcVotes = new Map()
    consensus.qc.justifyVerified = 0
    consensus.qc.justifyInvalid = 0
    consensus.qc.justifyQCs = 0
}

// Build a signed round-0 (or round-1) hash-only vote from `name` for `hash`.
function vote(name, h, round, hash, ts) {
    const savedName = process.env.NODE_OWNER
    const savedPriv = process.env.NODE_OWNER_PRIV
    process.env.NODE_OWNER = name
    process.env.NODE_OWNER_PRIV = bs58.encode(keys[name])
    const signed = consensus.signMessage({
        t: 6,
        d: { r: round, b: { hash: hash }, ts: ts || (1601477849000 + h), h: h }
    })
    process.env.NODE_OWNER = savedName
    process.env.NODE_OWNER_PRIV = savedPriv
    return signed
}

console.log('=== QC on the wire (h + justify) ===\n')

console.log('--- retention ---')

test('a compact round-0 vote is retained and justifiable', () => {
    reset()
    consensus.qcRememberVote(10, 0, 'H', 'l2', vote('l2', 10, 0, 'H'))
    const justify = consensus.qcBuildJustify(10, 0, 'H')
    assert.ok(Array.isArray(justify))
    assert.strictEqual(justify.length, 1)
    assert.strictEqual(justify[0].n, 'l2')
    assert.strictEqual(typeof justify[0].s, 'string')
})

test('a full-block round-0 vote is NOT retained (would blow up the payload)', () => {
    reset()
    const full = vote('l2', 10, 0, 'H')
    full.d.b = Object.assign({ _id: 10 }, full.d.b)
    consensus.qcRememberVote(10, 0, 'H', 'l2', full)
    assert.strictEqual(consensus.qcBuildJustify(10, 0, 'H'), null)
})

test('a vote without an explicit height is not retained (cannot be rebuilt)', () => {
    reset()
    const noH = vote('l2', 10, 0, 'H')
    delete noH.d.h
    consensus.qcRememberVote(10, 0, 'H', 'l2', noH)
    assert.strictEqual(consensus.qcBuildJustify(10, 0, 'H'), null)
})

test('the same signer is stored once', () => {
    reset()
    consensus.qcRememberVote(10, 0, 'H', 'l2', vote('l2', 10, 0, 'H'))
    consensus.qcRememberVote(10, 0, 'H', 'l2', vote('l2', 10, 0, 'H'))
    assert.strictEqual(consensus.qcBuildJustify(10, 0, 'H').length, 1)
})

console.log('\n--- verification ---')

test('valid signatures from 4 of 5 eligible leaders verify as a QC', () => {
    reset()
    const justify = NAMES.slice(0, 4).map(n => {
        const v = vote(n, 10, 0, 'H')
        return { n: n, s: v.s.s, ts: v.d.ts }
    })
    consensus.qcVerifyJustify(10, 0, 'H', justify, NAMES)
    assert.strictEqual(consensus.qc.justifyVerified, 4)
    assert.strictEqual(consensus.qc.justifyInvalid, 0)
    assert.strictEqual(consensus.qc.justifyQCs, 1)
})

test('a tampered timestamp fails verification', () => {
    reset()
    const v = vote('l2', 10, 0, 'H')
    const justify = [{ n: 'l2', s: v.s.s, ts: v.d.ts + 1 }]
    consensus.qcVerifyJustify(10, 0, 'H', justify, NAMES)
    assert.strictEqual(consensus.qc.justifyVerified, 0)
    assert.strictEqual(consensus.qc.justifyInvalid, 1)
})

test('a signature for a different hash fails verification', () => {
    reset()
    const v = vote('l2', 10, 0, 'OTHER')
    const justify = [{ n: 'l2', s: v.s.s, ts: v.d.ts }]
    consensus.qcVerifyJustify(10, 0, 'H', justify, NAMES)
    assert.strictEqual(consensus.qc.justifyVerified, 0)
    assert.strictEqual(consensus.qc.justifyInvalid, 1)
})

test('a signer outside the eligible set is ignored', () => {
    reset()
    const v = vote('l2', 10, 0, 'H')
    const justify = [{ n: 'intruder', s: v.s.s, ts: v.d.ts }]
    consensus.qcVerifyJustify(10, 0, 'H', justify, NAMES)
    assert.strictEqual(consensus.qc.justifyVerified, 0)
    assert.strictEqual(consensus.qc.justifyInvalid, 1)
})

test('below quorum verifies signatures but is not a QC', () => {
    reset()
    const justify = NAMES.slice(0, 3).map(n => {
        const v = vote(n, 10, 0, 'H')
        return { n: n, s: v.s.s, ts: v.d.ts }
    })
    consensus.qcVerifyJustify(10, 0, 'H', justify, NAMES)
    assert.strictEqual(consensus.qc.justifyVerified, 3)
    assert.strictEqual(consensus.qc.justifyQCs, 0)
})

test('justify is ignored when the shadow is disabled', () => {
    reset()
    consensus.qc.enabled = false
    const v = vote('l2', 10, 0, 'H')
    consensus.qcVerifyJustify(10, 0, 'H', [{ n: 'l2', s: v.s.s, ts: v.d.ts }], NAMES)
    assert.strictEqual(consensus.qc.justifyVerified, 0)
    consensus.qc.enabled = true
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
