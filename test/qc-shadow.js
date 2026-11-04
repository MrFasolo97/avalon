// == S0' shadow mode: production verdict vs ledger verdict ==
// node test/qc-shadow.js

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

const eligible = ['l1', 'l2', 'l3', 'l4', 'l5'] // n=5, q=4

function ledgerWith(entries) {
    const ledger = q.createLedger()
    for (const e of entries)
        q.recordVote(ledger, e)
    return ledger
}

console.log('=== S0\' shadow comparison ===\n')

console.log('--- agreement ---')

test('same votes, same verdict: no divergence logged', () => {
    const ledger = ledgerWith([
        { h: 1, r: 1, hash: 'A', signer: 'l1' },
        { h: 1, r: 1, hash: 'A', signer: 'l2' },
        { h: 1, r: 1, hash: 'A', signer: 'l3' },
        { h: 1, r: 1, hash: 'A', signer: 'l4' }
    ])
    const cmp = q.compareDecision({ productionCount: 4, threshold: 4, ledger, h: 1, r: 1, hash: 'A', eligible })
    assert.strictEqual(cmp.productionFinalizes, true)
    assert.strictEqual(cmp.qcFinalizes, true)
    assert.strictEqual(cmp.divergence, false)
    assert.strictEqual(cmp.unsafe, false)
    assert.strictEqual(cmp.late, false)
})

test('below quorum on both sides: no divergence', () => {
    const ledger = ledgerWith([
        { h: 1, r: 1, hash: 'A', signer: 'l1' },
        { h: 1, r: 1, hash: 'A', signer: 'l2' }
    ])
    const cmp = q.compareDecision({ productionCount: 2, threshold: 4, ledger, h: 1, r: 1, hash: 'A', eligible })
    assert.strictEqual(cmp.productionFinalizes, false)
    assert.strictEqual(cmp.qcFinalizes, false)
    assert.strictEqual(cmp.divergence, false)
})

console.log('\n--- the dangerous direction (unsafe) ---')

test('production finalises on votes the ledger cannot certify', () => {
    // production counted a vote from a signer that is not in the eligible set
    // (e.g. an observer's own non-broadcast vote, or a stale activeLeaders view)
    const ledger = ledgerWith([
        { h: 2, r: 1, hash: 'A', signer: 'l1' },
        { h: 2, r: 1, hash: 'A', signer: 'l2' },
        { h: 2, r: 1, hash: 'A', signer: 'l3' }
    ])
    const cmp = q.compareDecision({ productionCount: 4, threshold: 4, ledger, h: 2, r: 1, hash: 'A', eligible })
    assert.strictEqual(cmp.productionFinalizes, true)
    assert.strictEqual(cmp.qcFinalizes, false)
    assert.strictEqual(cmp.divergence, true)
    assert.strictEqual(cmp.unsafe, true)
    assert.strictEqual(cmp.qcCount, 3)
    assert.strictEqual(cmp.quorum, 4)
})

test('the observer penalty adjustment removes the false positive', () => {
    // same situation, but productionCount was corrected for our own ineligible
    // vote (what tryNextStep does in shadow mode)
    const ledger = ledgerWith([
        { h: 2, r: 1, hash: 'A', signer: 'l1' },
        { h: 2, r: 1, hash: 'A', signer: 'l2' },
        { h: 2, r: 1, hash: 'A', signer: 'l3' }
    ])
    const cmp = q.compareDecision({ productionCount: 3, threshold: 4, ledger, h: 2, r: 1, hash: 'A', eligible })
    assert.strictEqual(cmp.productionFinalizes, false)
    assert.strictEqual(cmp.divergence, false)
})

console.log('\n--- the wasteful direction (late) ---')

test('a QC exists but production has not finalised yet', () => {
    const ledger = ledgerWith([
        { h: 3, r: 1, hash: 'A', signer: 'l1' },
        { h: 3, r: 1, hash: 'A', signer: 'l2' },
        { h: 3, r: 1, hash: 'A', signer: 'l3' },
        { h: 3, r: 1, hash: 'A', signer: 'l4' },
        { h: 3, r: 1, hash: 'A', signer: 'l5' }
    ])
    // production is stricter: the observer +1 pushed its threshold to 5, and
    // the possBlock list only has 4 distinct names it counted
    const cmp = q.compareDecision({ productionCount: 4, threshold: 5, ledger, h: 3, r: 1, hash: 'A', eligible })
    assert.strictEqual(cmp.productionFinalizes, false)
    assert.strictEqual(cmp.qcFinalizes, true)
    assert.strictEqual(cmp.late, true)
    assert.strictEqual(cmp.unsafe, false)
})

console.log('\n--- the exact divergence the two formulas produce ---')

test('pre-fix force-finalize quorum was lower than the unified one at n=6', () => {
    const six = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']
    const ledger = ledgerWith([
        { h: 4, r: 0, hash: 'A', signer: 'l1' },
        { h: 4, r: 0, hash: 'A', signer: 'l2' },
        { h: 4, r: 0, hash: 'A', signer: 'l3' },
        { h: 4, r: 0, hash: 'A', signer: 'l4' }
    ])
    const legacy = q.legacyForceFinalizeQuorum(6, 5) // 4
    const unified = q.quorumSize(6) // 5
    const cmp = q.compareDecision({
        productionCount: 4, threshold: legacy, ledger, h: 4, r: 0, hash: 'A', eligible: six
    })
    assert.strictEqual(legacy, 4)
    assert.strictEqual(unified, 5)
    assert.strictEqual(cmp.productionFinalizes, true)
    assert.strictEqual(cmp.qcFinalizes, false)
    assert.strictEqual(cmp.unsafe, true)
    assert.strictEqual(cmp.quorum, 5)
})

test('blockQuorum() is exactly quorumSize() for every reachable leader set', () => {
    // the engine now calls blockQuorum() for both block consensus and
    // force-finalize, so this equality is what closes the hole above
    for (let n = 1; n <= 64; n++) assert.strictEqual(q.blockQuorum(n), q.quorumSize(n), 'n=' + n)
})

test('blockQuorum() does not stall small networks (testnet genesis)', () => {
    // the pre-fix floor of 3 was unreachable with 1 or 2 signers: the docker
    // testnet could never leave block 0
    assert.strictEqual(q.blockQuorum(1), 1)
    assert.strictEqual(q.blockQuorum(2), 2)
    assert.strictEqual(q.legacyForceFinalizeQuorum(1, 5), 3) // the deadlock
})

test('blockQuorum() is still strictly above n/2 (no minority can finalise)', () => {
    for (let n = 1; n <= 64; n++) assert.ok(q.blockQuorum(n) * 2 > n, 'n=' + n)
})

test('blockQuorum() fails closed on an empty leader set', () => {
    assert.strictEqual(q.blockQuorum(0), 3)
    assert.strictEqual(q.quorumSize(0), Infinity)
})

test('blockQuorum() honours an explicit minimum (config.quorumMin)', () => {
    assert.strictEqual(q.blockQuorum(4, 4), 4) // raised floor: 4 of 4 = unanimity
    assert.strictEqual(q.blockQuorum(5, 4), 4) // quorumSize(5)=4 already
    assert.strictEqual(q.blockQuorum(6, 5), 5) // quorumSize(6)=5 already
    assert.strictEqual(q.blockQuorum(1, 4), 1) // never asks for more signers than exist
    assert.strictEqual(q.blockQuorum(4, 3), 3) // default-equivalent
    assert.strictEqual(q.blockQuorum(4), 3)    // undefined min falls back to 3
})

console.log('\n--- ledger hygiene ---')

test('pruneLedger drops old heights and keeps recent ones', () => {
    const ledger = ledgerWith([
        { h: 10, r: 1, hash: 'A', signer: 'l1' },
        { h: 11, r: 1, hash: 'B', signer: 'l1' },
        { h: 12, r: 1, hash: 'C', signer: 'l1' }
    ])
    const dropped = q.pruneLedger(ledger, 11)
    assert.strictEqual(dropped, 1)
    assert.strictEqual(q.hasQC(ledger, 10, 1, 'A', ['l1']).count, 0)
    assert.strictEqual(q.hasQC(ledger, 11, 1, 'B', ['l1']).count, 1)
    assert.strictEqual(q.hasQC(ledger, 12, 1, 'C', ['l1']).count, 1)
})

test('pruneLedger is a no-op on an empty ledger', () => {
    assert.strictEqual(q.pruneLedger(q.createLedger(), 5), 0)
})

console.log('\n--- shadow mode never changes the production verdict ---')

test('compareDecision is a pure reader: the ledger is not mutated', () => {
    const ledger = ledgerWith([{ h: 5, r: 1, hash: 'A', signer: 'l1' }])
    const before = q.hasQC(ledger, 5, 1, 'A', eligible).count
    q.compareDecision({ productionCount: 1, threshold: 4, ledger, h: 5, r: 1, hash: 'A', eligible })
    const after = q.hasQC(ledger, 5, 1, 'A', eligible).count
    assert.strictEqual(before, after)
})

test('an ineligible threshold can never produce a QC (fail closed)', () => {
    const ledger = q.createLedger()
    const cmp = q.compareDecision({ productionCount: 99, threshold: 1, ledger, h: 6, r: 1, hash: 'A', eligible: [] })
    assert.strictEqual(cmp.qcFinalizes, false)
    assert.strictEqual(cmp.quorum, Infinity)
    assert.strictEqual(cmp.unsafe, true)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
