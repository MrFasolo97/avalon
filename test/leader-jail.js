// test/leader-jail.js — unit tests for src/leaderHealth.js (prototype kernel)
//
// Run with: node test/leader-jail.js
// These are pure-function tests: no db, no p2p, no timers.
const assert = require('assert')
const lh = require('../src/leaderHealth')

let passed = 0
function test(name, fn) {
    fn()
    passed++
    console.log('PASS: ' + name)
}

// helpers ---------------------------------------------------------------------
function blk(id, miner, skips, txs) {
    const b = { _id: id, miner, timestamp: id * 3000, txs: txs || [] }
    if (skips && skips.length) b.skips = skips
    return b
}
function chainOf(specs) {
    // specs: [[miner, skips], ...] starting at height 1
    return specs.map((s, i) => blk(i + 1, s[0], s[1] || [], s[2] || []))
}
const LADDER = ['miner1', 'miner2', 'miner3', 'miner4', 'miner5', 'standby1']

// 1. canonical ordering -------------------------------------------------------
test('candidates sorted by node_appr desc, ties by name asc', () => {
    const ranked = lh.rankCandidates([
        { name: 'zeta', node_appr: 100 },
        { name: 'alpha', node_appr: 100 },
        { name: 'beta', node_appr: 300 },
        { name: 'zero', node_appr: 0 },
    ], { leaders: 2, leaderStandbys: 1 })
    assert.deepStrictEqual(ranked.all.map(c => c.name), ['beta', 'alpha', 'zeta'])
    assert.deepStrictEqual(ranked.active.map(c => c.name), ['beta', 'alpha'])
    assert.deepStrictEqual(ranked.standby.map(c => c.name), ['zeta'])
})

// 2. shuffle determinism ------------------------------------------------------
test('epoch shuffle is deterministic for the same hash and input order', () => {
    const cands = ['a', 'b', 'c', 'd', 'e'].map(n => ({ name: n }))
    const h = 'f'.repeat(50) + '012345'
    const s1 = lh.shuffleEpoch(cands, h, 6).map(c => c.name)
    const s2 = lh.shuffleEpoch(cands, h, 6).map(c => c.name)
    assert.deepStrictEqual(s1, s2)
    assert.deepStrictEqual(s1.slice().sort(), ['a', 'b', 'c', 'd', 'e'])
})

// 3. ladder -------------------------------------------------------------------
test('ladder: scheduled leader first, then recent producers, then standbys', () => {
    const recent = chainOf([['miner9', []], ['miner8', []], ['miner7', []]])
    const ladder = lh.ladderFor(4, {
        shuffle: [{ name: 'miner1' }, { name: 'miner2' }, { name: 'miner3' }],
        recentBlocks: recent,
        leaders: 3,
        standbys: [{ name: 'miner4' }],
        standbyEnabled: true,
    })
    assert.deepStrictEqual(ladder, ['miner1', 'miner7', 'miner8', 'miner9', 'miner4'])
})

test('ladder: dedupes the scheduled leader when it is also the last producer', () => {
    const recent = chainOf([['miner2', []]])
    const ladder = lh.ladderFor(2, {
        shuffle: [{ name: 'miner1' }, { name: 'miner2' }, { name: 'miner3' }],
        recentBlocks: recent,
        leaders: 3,
    })
    // slot (2-1)%3 = 1 -> miner2, which is also miner(h-1): appears once
    assert.deepStrictEqual(ladder, ['miner2'])
})

test('ladder: standbys do not appear when Layer H is disabled', () => {
    const ladder = lh.ladderFor(2, {
        shuffle: [{ name: 'miner1' }, { name: 'miner3' }, { name: 'miner5' }],
        recentBlocks: chainOf([['miner2', []]]),
        leaders: 3,
        standbys: [{ name: 'miner4' }],
        standbyEnabled: false,
    })
    assert.deepStrictEqual(ladder, ['miner3', 'miner2'])
})

// 4. attestation --------------------------------------------------------------
test('attestation: scheduled leader attests no skip', () => {
    const a = lh.attestation(blk(10, 'miner1', []), LADDER)
    assert.strictEqual(a.ok, true)
    assert.deepStrictEqual(a.expected, [])
})

test('attestation: backup of position 2 attests the two leaders above it', () => {
    const a = lh.attestation(blk(10, 'miner3', ['miner1', 'miner2']), LADDER)
    assert.strictEqual(a.ok, true)
    assert.deepStrictEqual(a.expected, ['miner1', 'miner2'])
})

test('attestation: missing or wrong skips are detected (Layer S warns, Layer H rejects)', () => {
    assert.strictEqual(lh.attestation(blk(10, 'miner3', []), LADDER).ok, false)
    assert.strictEqual(lh.attestation(blk(10, 'miner3', ['miner2']), LADDER).ok, false)
    assert.strictEqual(lh.attestation(blk(10, 'miner3', ['miner2', 'miner1']), LADDER).ok, false)
    assert.strictEqual(lh.attestation(blk(10, 'unknown', []), LADDER).reason, 'miner-not-in-ladder')
})

test('attestation: legacy missedBy is accepted as a single skip', () => {
    const b = { _id: 10, miner: 'miner2', missedBy: 'miner1' }
    assert.strictEqual(lh.attestation(b, LADDER).ok, true)
})

// 5. jail accounting ----------------------------------------------------------
test('jail: N proven consecutive misses jail the leader', () => {
    // miner2 is skipped 3 times (N=3) by three different producers
    const blocks = chainOf([
        ['miner1', []],
        ['miner3', ['miner2']],
        ['miner1', ['miner2']],
        ['miner3', ['miner2']],
    ])
    const state = lh.jailState(blocks, { jailMissThreshold: 3, jailBlocks: 20, lookback: 100 })
    assert.strictEqual(lh.stateOf(state, 'miner2').jailCount, 1)
    assert.strictEqual(lh.isJailed(state, 'miner2', 4), true)
    // jailedUntil = height of the 3rd skip + 20 = 4 + 20
    assert.strictEqual(lh.stateOf(state, 'miner2').jailedUntil, 24)
    assert.strictEqual(lh.isJailed(state, 'miner2', 24), false)
})

test('jail: production between misses resets the streak', () => {
    const blocks = chainOf([
        ['miner3', ['miner2']],
        ['miner3', ['miner2']],
        ['miner2', []],              // alive again
        ['miner3', ['miner2']],
    ])
    const state = lh.jailState(blocks, { jailMissThreshold: 3, lookback: 100 })
    assert.strictEqual(lh.stateOf(state, 'miner2').streak, 1)
    assert.strictEqual(lh.stateOf(state, 'miner2').jailCount, 0)
})

test('jail: backoff doubles the duration on the second jail', () => {
    let specs = []
    // first jail: 3 misses
    specs.push(['miner1', []], ['miner3', ['miner2']], ['miner1', ['miner2']], ['miner3', ['miner2']])
    // jail 4 -> 24 (J=20): after expiry, 3 more misses -> second jail lasts 40
    for (let h = 5; h < 24; h++) specs.push(['miner1', []])
    specs.push(['miner3', ['miner2']], ['miner1', ['miner2']], ['miner3', ['miner2']])
    const state = lh.jailState(chainOf(specs), { jailMissThreshold: 3, jailBlocks: 20, jailBackoffMax: 4, lookback: 100 })
    const e = lh.stateOf(state, 'miner2')
    assert.strictEqual(e.jailCount, 2)
    assert.strictEqual(e.jailedUntil, (specs.length) + 40)
})

test('jail: heartbeat tx (ENABLE_NODE, type 18) un-jails immediately', () => {
    const blocks = chainOf([
        ['miner1', []],
        ['miner3', ['miner2']],
        ['miner1', ['miner2']],
        ['miner3', ['miner2']],
        ['miner1', [], [{ type: 18, sender: 'miner2' }]],
    ])
    const state = lh.jailState(blocks, { jailMissThreshold: 3, jailBlocks: 20, lookback: 100 })
    assert.strictEqual(lh.isJailed(state, 'miner2', 5), false)
    assert.strictEqual(lh.stateOf(state, 'miner2').streak, 0)
})

test('jail: a jailed leader is not scheduled and accrues no new misses', () => {
    const blocks = chainOf([
        ['miner3', ['miner2']],
        ['miner3', ['miner2']],
        ['miner3', ['miner2']], // jailed here, until 23
        ['miner1', []],
        ['miner1', []],
    ])
    const state = lh.jailState(blocks, { jailMissThreshold: 3, jailBlocks: 20, lookback: 100 })
    assert.strictEqual(lh.stateOf(state, 'miner2').streak, 0)
    assert.strictEqual(lh.isJailed(state, 'miner2', 5), true)
})

// 6. adaptive quorum ----------------------------------------------------------
test('quorum: mainnet parameters q = min(4, max(3, E))', () => {
    const p = { quorumMin: 3, quorumCap: 4 }
    assert.strictEqual(lh.quorumSize(5, p), 4)
    assert.strictEqual(lh.quorumSize(4, p), 4)
    assert.strictEqual(lh.quorumSize(3, p), 3)
    assert.strictEqual(lh.quorumSize(2, p), 3) // halts: 2 live can never reach 3
})

test('quorum: 3-node testnet with quorumMin=2 tolerates one death', () => {
    const p = { quorumMin: 2, quorumCap: 4 }
    assert.strictEqual(lh.quorumSize(3, p), 3)
    assert.strictEqual(lh.quorumSize(2, p), 2)
    assert.strictEqual(lh.quorumSize(1, p), 2) // halts
})

test('quorum: lastTurn eligibility drops a leader whose turn was skipped', () => {
    const leaders = ['miner1', 'miner2', 'miner3']
    const blocks = chainOf([['miner1', []], ['miner3', ['miner2']]])
    const state = lh.jailState(blocks, { jailMissThreshold: 30, lookback: 100 })
    const q = lh.quorumFor(leaders, state, 2, { quorumMin: 2, quorumCap: 4 })
    assert.deepStrictEqual(q.eligible, ['miner1', 'miner3'])
    assert.strictEqual(q.E, 2)
    assert.strictEqual(q.q, 2)
})

test('quorum: a jailed leader is excluded from the denominator', () => {
    const leaders = ['miner1', 'miner2', 'miner3']
    const blocks = chainOf([
        ['miner1', ['miner2']], ['miner3', ['miner2']], ['miner1', ['miner2']],
    ])
    const state = lh.jailState(blocks, { jailMissThreshold: 3, jailBlocks: 20, lookback: 100 })
    const q = lh.quorumFor(leaders, state, 3, { quorumMin: 2, quorumCap: 4 })
    assert.deepStrictEqual(q.eligible, ['miner1', 'miner3'])
    assert.strictEqual(q.q, 2)
})

// --- per-height commit lock ---------------------------------------------------
const X = { hash: 'aaaa', miner: 'miner1', _id: 100 }
const Y = { hash: 'bbbb', miner: 'dtube', _id: 100 }

test('commit lock: the first candidate is committed and locks the height', () => {
    const d = lh.commitDecision({}, 100, X, null)
    assert.strictEqual(d.allow, true)
    assert.strictEqual(d.reason, 'unlocked')
    assert.strictEqual(d.lock, true)
    assert.strictEqual(d.overridden, false)
})

test('commit lock: re-committing the same block is idempotent', () => {
    const d = lh.commitDecision({ 100: { hash: X.hash, miner: X.miner } }, 100, X, null)
    assert.strictEqual(d.allow, true)
    assert.strictEqual(d.reason, 'same-block')
    assert.strictEqual(d.lock, false)
})

test('commit lock: a second block at the same height is refused', () => {
    const d = lh.commitDecision({ 100: { hash: X.hash, miner: X.miner } }, 100, Y, null)
    assert.strictEqual(d.allow, false)
    assert.strictEqual(d.reason, 'locked')
    assert.strictEqual(d.lockedHash, X.hash)
    assert.strictEqual(d.lockedMiner, 'miner1')
})

test('commit lock: different heights do not interfere', () => {
    const d = lh.commitDecision({ 100: { hash: X.hash, miner: X.miner } }, 101, Y, null)
    assert.strictEqual(d.allow, true)
    assert.strictEqual(d.reason, 'unlocked')
})

test('commit lock: the haltBreaker can override the lock for its own height', () => {
    const locks = { 100: { hash: X.hash, miner: X.miner } }
    const d = lh.commitDecision(locks, 100, Y, { height: 100, hash: Y.hash })
    assert.strictEqual(d.allow, true)
    assert.strictEqual(d.reason, 'breaker-override')
    assert.strictEqual(d.overridden, true)
    assert.strictEqual(d.lock, true)
})

test('commit lock: an override for another height or another hash is ignored', () => {
    const locks = { 100: { hash: X.hash, miner: X.miner } }
    assert.strictEqual(lh.commitDecision(locks, 100, Y, { height: 101, hash: Y.hash }).allow, false)
    assert.strictEqual(lh.commitDecision(locks, 100, Y, { height: 100, hash: 'cccc' }).allow, false)
})

test('commit lock: a candidate without hash is never committed', () => {
    const d = lh.commitDecision({}, 100, { miner: 'miner1' }, null)
    assert.strictEqual(d.allow, false)
    assert.strictEqual(d.reason, 'no-candidate')
})

test('breaker threshold: majority of the eligible set', () => {
    assert.strictEqual(lh.breakerThreshold(1), 1)
    assert.strictEqual(lh.breakerThreshold(2), 2)
    assert.strictEqual(lh.breakerThreshold(3), 2)
    assert.strictEqual(lh.breakerThreshold(4), 3)
    assert.strictEqual(lh.breakerThreshold(5), 3)
    assert.strictEqual(lh.breakerThreshold(6), 4)
})

// 8. edge cases ---------------------------------------------------------------
test('edge case: E=1 quorum is the floor', () => {
    const q = lh.quorumFor(['miner1'], lh.jailState([], {}), 1, { quorumMin: 3, quorumCap: 4 })
    assert.strictEqual(q.E, 1)
    assert.strictEqual(q.q, 3) // halts unless testnet carve-out
})

test('edge case: E=2 never reaches quorumMin=3', () => {
    const q = lh.quorumFor(['miner1', 'miner2'], lh.jailState([], {}), 1, { quorumMin: 3, quorumCap: 4 })
    assert.strictEqual(q.E, 2)
    assert.strictEqual(q.q, 3)
})

test('edge case: all active leaders jailed leaves only standbys', () => {
    const blocks = chainOf([
        ['miner3', ['miner1']], ['miner2', ['miner1']], ['miner3', ['miner1']],
        ['miner3', ['miner2']], ['miner1', ['miner2']], ['miner3', ['miner2']],
    ])
    const state = lh.jailState(blocks, { jailMissThreshold: 3, jailBlocks: 20, lookback: 100 })
    assert.strictEqual(lh.isJailed(state, 'miner1', 6), true)
    assert.strictEqual(lh.isJailed(state, 'miner2', 6), true)
})

// 9. commit lock store --------------------------------------------------------
test('commit lock store: persists and reloads locks', () => {
    const store = require('../src/commitLockStore')
    const tmp = process.env.COMMIT_LOCK_DIR
    const tmpOwner = process.env.NODE_OWNER
    process.env.COMMIT_LOCK_DIR = '/tmp/opencode/avalon-jail-commit-test'
    process.env.NODE_OWNER = 'testnode'
    try {
        // clean slate
        try { require('fs').unlinkSync(store.filePath()) } catch (e) {}
        store.append(10, 'hash10', 'miner1')
        store.append(11, 'hash11', 'miner2')
        const loaded = store.load()
        assert.strictEqual(loaded[10].hash, 'hash10')
        assert.strictEqual(loaded[11].miner, 'miner2')
        store.cleanup(11, 0)
        const cleaned = store.load()
        assert.strictEqual(cleaned[10], undefined)
        assert.strictEqual(cleaned[11].hash, 'hash11')
    } finally {
        process.env.COMMIT_LOCK_DIR = tmp
        process.env.NODE_OWNER = tmpOwner
    }
})

console.log('\n' + passed + ' tests passed')
