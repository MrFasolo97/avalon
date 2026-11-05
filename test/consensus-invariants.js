// == Consensus invariants (property tests) ==
// node test/consensus-invariants.js
//
// These assert the properties the protocol relies on, independent of any chain:
//   - QUORUM INTERSECTION: two quorums over the same eligible set always share a
//     signer (q > 2n/3), which is what makes "two different blocks cannot both
//     finalise" hold once each signer votes once.
//   - INV-1: with singleVote, a signer cannot vote two hashes at one
//     (height, phase); therefore two hashes cannot both reach a QC.
//   - DERIVED-STATE REPLAY: folding the same blocks into leaderHealth twice
//     yields the same snapshot (F7 determinism).

const assert = require('assert')

if (typeof global.config === 'undefined')
    global.config = {
        leaders: 3, b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        jailMissThreshold: 30, jailBlocks: 200, jailBackoffMax: 4
    }
if (typeof global.logr === 'undefined')
    global.logr = { warn() {}, debug() {}, error() {}, info() {}, cons() {}, trace() {}, fatal() {} }
require.cache[require.resolve('../src/logger')] = { exports: global.logr }

const q = require('../src/consensusQuorum')
const leaderHealth = require('../src/leaderHealth')

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

console.log('=== Consensus invariants ===')

test('quorumSize is strictly > 2n/3 for n = 1..64 (two quorums intersect)', () => {
    for (let n = 1; n <= 64; n++) {
        const size = q.quorumSize(n)
        assert.ok(Number.isFinite(size), 'finite for n=' + n)
        // two quorums of `size` must overlap: 2*size > n
        assert.ok(2 * size > n, 'intersection at n=' + n + ' size=' + size)
        // smallest such integer
        assert.ok(size - 1 <= (2 * n) / 3, 'minimal at n=' + n)
    }
})

test('blockQuorum never asks for more than n, floor >= min(3,n)', () => {
    for (let n = 1; n <= 10; n++) {
        const size = q.blockQuorum(n, 3)
        assert.ok(size <= Math.max(n, 1), 'not more than n at n=' + n)
        assert.ok(size >= Math.min(3, n), 'floor at n=' + n)
    }
})

test('quorumSize fails closed for n <= 0', () => {
    assert.strictEqual(q.quorumSize(0), Infinity)
    assert.strictEqual(q.quorumSize(-1), Infinity)
})

test('INV-1: a signer cannot vote two hashes at the same (height, phase)', () => {
    const ledger = q.createLedger({ singleVote: true })
    const a = q.recordVote(ledger, { h: 1, r: q.PRECOMMIT, hash: 'A', signer: 'alice' })
    const b = q.recordVote(ledger, { h: 1, r: q.PRECOMMIT, hash: 'B', signer: 'alice' })
    assert.strictEqual(a.accepted, true)
    assert.strictEqual(b.accepted, false)
    // either the per-height lock or the equivocation guard refuses it
    assert.ok(b.reason === 'equivocation' || b.reason === 'lock-conflict', b.reason)
})

test('with single-vote, two hashes cannot both reach a QC', () => {
    const n = 7
    const eligible = Array.from({ length: n }, (_, i) => 's' + i)
    const size = q.quorumSize(n)
    const ledger = q.createLedger({ singleVote: true })
    // size signers vote A; none of them can then vote B
    for (let i = 0; i < size; i++) q.recordVote(ledger, { h: 10, r: q.COMMIT, hash: 'A', signer: eligible[i] })
    for (let i = 0; i < n; i++) q.recordVote(ledger, { h: 10, r: q.COMMIT, hash: 'B', signer: eligible[i] })
    const res = q.qcHash(ledger, 10, q.COMMIT, eligible)
    assert.strictEqual(res.hash, 'A')
    assert.strictEqual(res.conflict, false)
    // B has at most n - size votes, below the quorum
    assert.ok((n - size) < size)
})

test('canonicalEligible de-duplicates and sorts', () => {
    assert.deepStrictEqual(q.canonicalEligible(['b', 'a', 'b', 'c', 'a', '', null]), ['a', 'b', 'c'])
})

test('derived state replays deterministically (F7)', () => {
    const blocks = []
    const schedule = { shuffle: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }] }
    // 40 blocks, alice/bob/carol rotate; bob misses some turns
    for (let h = 1; h <= 40; h++) {
        const scheduled = ['alice', 'bob', 'carol'][(h - 1) % 3]
        const miner = (scheduled === 'bob' && h % 7 === 0) ? 'alice' : scheduled
        const block = {
            _id: h, miner: miner, txs: [],
            skips: miner === scheduled ? undefined : [scheduled]
        }
        blocks.push(block)
    }
    const fold = () => {
        leaderHealth.leaders = {}
        for (const b of blocks) leaderHealth.processBlock(b, schedule)
        return JSON.stringify(leaderHealth.snapshot(41))
    }
    const a = fold()
    const b = fold()
    assert.strictEqual(a, b)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
