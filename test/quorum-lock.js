// == Single quorum function + vote ledger ==
// Design: doc/consensus-single-quorum-and-locks.en.md
// assert-only, no DB, no sockets: node test/quorum-lock.js

const assert = require('assert')
const q = require('../src/consensusQuorum')

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' \u2014 ' + e.message)
        failed++
    }
}

console.log('=== Quorum + ledger ===\n')

console.log('--- quorumSize(n) ---')

test('is the smallest integer strictly above 2n/3', () => {
    for (let n = 1; n <= 64; n++)
        assert.ok(q.quorumSize(n) * 3 > 2 * n, 'not > 2/3 at n=' + n)
})

test('matches the values the chain uses today (n = 3,4,5)', () => {
    assert.strictEqual(q.quorumSize(3), 3)
    assert.strictEqual(q.quorumSize(4), 3)
    assert.strictEqual(q.quorumSize(5), 4)
})

test('is monotonic non-decreasing', () => {
    for (let n = 1; n < 64; n++)
        assert.ok(q.quorumSize(n + 1) >= q.quorumSize(n), 'regressed at n=' + n)
})

test('fails closed on an empty eligible set', () => {
    assert.strictEqual(q.quorumSize(0), Infinity)
    assert.strictEqual(q.quorumSize(-1), Infinity)
    assert.strictEqual(q.quorumSize(2.5), Infinity)
})

console.log('\n--- unified vs legacy force-finalize formula ---')

test('identical to the legacy FF quorum at n = 3,4,5 (no behaviour change today)', () => {
    for (const n of [3, 4, 5])
        assert.strictEqual(q.quorumSize(n), q.legacyForceFinalizeQuorum(n, 5), 'diverges at n=' + n)
})

test('diverges from the legacy FF quorum at n = 6 (latent hole, activated by Layer H)', () => {
    // floor(2*6/3)+1 = 5 vs min(ceil(10/3), max(ceil(12/3), 3)) = 4
    assert.strictEqual(q.quorumSize(6), 5)
    assert.strictEqual(q.legacyForceFinalizeQuorum(6, 5), 4)
    assert.notStrictEqual(q.quorumSize(6), q.legacyForceFinalizeQuorum(6, 5))
})

test('legacy FF quorum can land on exactly 2/3 (never strictly above)', () => {
    // n=6 -> 4/6 = exactly 2/3: a quorum that does not intersect itself
    assert.ok(4 * 3 <= 2 * 6)
})

console.log('\n--- canonical eligible set ---')

test('is order independent and de-duplicated', () => {
    const a = q.canonicalEligible(['b', 'a', 'c', 'a'])
    const b = q.canonicalEligible(['c', 'b', 'a'])
    assert.deepStrictEqual(a, ['a', 'b', 'c'])
    assert.deepStrictEqual(a, b)
})

test('drops junk entries instead of polluting the denominator', () => {
    assert.deepStrictEqual(q.canonicalEligible(['a', '', null, 'b', 7]), ['a', 'b'])
})

console.log('\n--- single-vote rule (the load-bearing invariant) ---')

// n = 4, q = 3. Two "partition" halves vote for A and B. Without the
// single-vote rule the two halves can both reach 3 and both "finalise".
function partitionRun(singleVote) {
    const eligible = ['l1', 'l2', 'l3', 'l4']
    const ledger = q.createLedger({ singleVote })
    // l3 and l4 are the equivocating/misconfigured pair: same key, two views
    for (const signer of ['l1', 'l2', 'l3'])
        q.recordVote(ledger, { h: 100, r: q.COMMIT, hash: 'A', signer })
    for (const signer of ['l3', 'l4', 'l1'])
        q.recordVote(ledger, { h: 100, r: q.COMMIT, hash: 'B', signer })
    return {
        ledger,
        A: q.hasQC(ledger, 100, q.COMMIT, 'A', eligible),
        B: q.hasQC(ledger, 100, q.COMMIT, 'B', eligible),
        detected: ledger.equivocations.length
    }
}

test('without the rule, two QCs at the same height are reachable (the current hole)', () => {
    const run = partitionRun(false)
    assert.ok(run.A.qc && run.B.qc, 'expected both halves to reach quorum')
    // the double votes are still DETECTED (that is what the shadow counts),
    // they are simply not refused: two conflicting QCs remain reachable
    assert.strictEqual(run.detected, 2)
})

test('with the rule, the second QC is impossible and the equivocation is recorded', () => {
    const run = partitionRun(true)
    assert.ok(run.A.qc, 'A should still reach quorum')
    assert.ok(!run.B.qc, 'B must not reach quorum')
    assert.strictEqual(run.detected, 2) // l3 double-voted, l1 double-voted
})

test('at most one QC per (height, phase) under random interleavings', () => {
    const eligible = ['a', 'b', 'c', 'd', 'e']
    const hashes = ['A', 'B', 'C']
    let seed = 1234567
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

    for (let trial = 0; trial < 5000; trial++) {
        const ledger = q.createLedger()
        const ballots = []
        for (const signer of eligible)
            for (let v = 0; v < 3; v++)
                ballots.push({ signer, hash: hashes[Math.floor(rnd() * hashes.length)] })
        // shuffle = adversarial arrival order
        for (let i = ballots.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1))
            const t = ballots[i]; ballots[i] = ballots[j]; ballots[j] = t
        }
        for (const b of ballots)
            q.recordVote(ledger, { h: 7, r: q.COMMIT, hash: b.hash, signer: b.signer })

        const res = q.qcHash(ledger, 7, q.COMMIT, eligible)
        assert.ok(!res.conflict, 'two QCs at the same height/phase on trial ' + trial)
    }
})

test('a QC never counts a signer outside the eligible set', () => {
    const eligible = ['a', 'b', 'c']
    const ledger = q.createLedger()
    for (const signer of ['a', 'intruder', 'mallory'])
        q.recordVote(ledger, { h: 3, r: q.COMMIT, hash: 'X', signer })
    const res = q.hasQC(ledger, 3, q.COMMIT, 'X', eligible)
    assert.strictEqual(res.count, 1)
    assert.strictEqual(res.qc, false)
})

test('the same signer counted once, however many times it repeats itself', () => {
    const ledger = q.createLedger()
    for (let i = 0; i < 10; i++)
        q.recordVote(ledger, { h: 4, r: q.COMMIT, hash: 'X', signer: 'a' })
    assert.strictEqual(q.hasQC(ledger, 4, q.COMMIT, 'X', ['a', 'b', 'c']).count, 1)
})

console.log('\n--- lock / unlock ---')

test('after precommitting A, precommitting B is refused', () => {
    const ledger = q.createLedger()
    assert.strictEqual(q.recordVote(ledger, { h: 9, r: q.PRECOMMIT, hash: 'A', signer: 'self' }).accepted, true)
    const res = q.recordVote(ledger, { h: 9, r: q.PRECOMMIT, hash: 'B', signer: 'self' })
    assert.strictEqual(res.accepted, false)
    assert.strictEqual(res.reason, 'lock-conflict')
    assert.strictEqual(q.lockedOn(ledger, 9), 'A')
    assert.strictEqual(q.canPrecommit(ledger, 9, 'A'), true)
    assert.strictEqual(q.canPrecommit(ledger, 9, 'B'), false)
})

test('the lock is per height: the next height starts unlocked', () => {
    const ledger = q.createLedger()
    q.recordVote(ledger, { h: 9, r: q.PRECOMMIT, hash: 'A', signer: 'self' })
    assert.strictEqual(q.recordVote(ledger, { h: 10, r: q.PRECOMMIT, hash: 'B', signer: 'self' }).accepted, true)
    assert.strictEqual(q.lockedOn(ledger, 10), 'B')
})

test('the lock does not block commit votes (we must still be able to finalise)', () => {
    const ledger = q.createLedger()
    q.recordVote(ledger, { h: 9, r: q.PRECOMMIT, hash: 'A', signer: 'self' })
    assert.strictEqual(q.recordVote(ledger, { h: 9, r: q.COMMIT, hash: 'A', signer: 'self' }).accepted, true)
})

test('an exact duplicate is accepted idempotently', () => {
    const ledger = q.createLedger()
    q.recordVote(ledger, { h: 9, r: q.COMMIT, hash: 'A', signer: 'self' })
    const res = q.recordVote(ledger, { h: 9, r: q.COMMIT, hash: 'A', signer: 'self' })
    assert.strictEqual(res.accepted, true)
    assert.strictEqual(res.reason, 'duplicate')
})

console.log('\n--- malformed input ---')

test('rejects non-integer heights, unknown phases and empty hashes', () => {
    const ledger = q.createLedger()
    assert.strictEqual(q.recordVote(ledger, { h: '1', r: q.COMMIT, hash: 'A', signer: 'a' }).reason, 'invalid-height')
    assert.strictEqual(q.recordVote(ledger, { h: 1, r: 2, hash: 'A', signer: 'a' }).reason, 'invalid-phase')
    assert.strictEqual(q.recordVote(ledger, { h: 1, r: q.COMMIT, hash: '', signer: 'a' }).reason, 'invalid-hash')
    assert.strictEqual(q.recordVote(ledger, { h: 1, r: q.COMMIT, hash: 'A', signer: '' }).reason, 'invalid-signer')
    assert.strictEqual(q.recordVote(ledger, null).reason, 'invalid-height')
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
