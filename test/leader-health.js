// == Leader health state machine (Layer S/H) ==
// node test/leader-health.js

const assert = require('assert')
const leaderHealth = require('../src/leaderHealth')

// Stub the global config used by leaderHealth
if (typeof global.config === 'undefined')
    global.config = {
        jailMissThreshold: 30,
        jailBlocks: 200,
        jailBackoffMax: 4,
        leaders: 3
    }

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
    leaderHealth.leaders = {}
}

function block(h, miner, skips, txs) {
    return { _id: h, miner: miner, skips: skips, txs: txs || [] }
}

console.log('=== Leader health ===\n')

console.log('--- production / skip accounting ---')

test('producing a block clears streak and records lastProduced', () => {
    reset()
    leaderHealth.processBlock(block(1, 'alice', []), null)
    const l = leaderHealth.get('alice')
    assert.strictEqual(l.produced, 1)
    assert.strictEqual(l.lastProduced, 1)
    assert.strictEqual(l.streak, 0)
})

test('a scheduled skip increments streak', () => {
    reset()
    leaderHealth.processBlock(block(1, 'bob', ['alice']), null)
    const l = leaderHealth.get('alice')
    assert.strictEqual(l.missed, 1)
    assert.strictEqual(l.streak, 1)
    assert.deepStrictEqual(l.lastSkip, { height: 1, position: 0 })
})

test('backup skips do not count toward streak', () => {
    reset()
    // ladder = [A, B, C, D, E], producer = C, skips = [A, B]
    // A is the scheduled leader (position 0), B is a backup (position 1)
    leaderHealth.processBlock(block(1, 'carol', ['alice', 'bob']), { shuffle: [
        { name: 'alice' }, { name: 'bob' }, { name: 'carol' }, { name: 'dave' }, { name: 'eve' }
    ]})
    assert.strictEqual(leaderHealth.get('alice').streak, 1)
    assert.strictEqual(leaderHealth.get('bob').streak, 0)
})

test('streak resets on production', () => {
    reset()
    for (let i = 0; i < 5; i++)
        leaderHealth.processBlock(block(i + 1, 'bob', ['alice']), null)
    assert.strictEqual(leaderHealth.get('alice').streak, 5)
    leaderHealth.processBlock(block(6, 'alice', []), null)
    assert.strictEqual(leaderHealth.get('alice').streak, 0)
})

console.log('\n--- jail ---')

test('jail triggers after N consecutive scheduled misses', () => {
    reset()
    const N = config.jailMissThreshold || 30
    for (let i = 0; i < N; i++)
        leaderHealth.processBlock(block(i + 1, 'bob', ['alice']), null)
    assert.strictEqual(leaderHealth.isJailed('alice', N), true)
    assert.ok(leaderHealth.get('alice').jail.untilBlock > N)
})

test('jail expires after untilBlock', () => {
    reset()
    const N = config.jailMissThreshold || 30
    for (let i = 0; i < N; i++)
        leaderHealth.processBlock(block(i + 1, 'bob', ['alice']), null)
    const until = leaderHealth.get('alice').jail.untilBlock
    assert.strictEqual(leaderHealth.isJailed('alice', until - 1), true)
    assert.strictEqual(leaderHealth.isJailed('alice', until), false)
})

test('heartbeat (type 18) clears jail immediately', () => {
    reset()
    const N = config.jailMissThreshold || 30
    for (let i = 0; i < N; i++)
        leaderHealth.processBlock(block(i + 1, 'bob', ['alice']), null)
    leaderHealth.processBlock(block(N + 1, 'bob', [], [{ type: 18, sender: 'alice' }]), null)
    assert.strictEqual(leaderHealth.isJailed('alice', N + 1), false)
    assert.strictEqual(leaderHealth.get('alice').jail.probation, true)
})

test('production during probation returns the leader to ACTIVE (design §6.2)', () => {
    reset()
    const N = config.jailMissThreshold || 30
    for (let i = 0; i < N; i++)
        leaderHealth.processBlock(block(i + 1, 'bob', ['alice']), null)
    leaderHealth.processBlock(block(N + 1, 'bob', [], [{ type: 18, sender: 'alice' }]), null) // heartbeat
    assert.strictEqual(leaderHealth.get('alice').jail.probation, true)
    leaderHealth.processBlock(block(N + 2, 'alice', []), null) // produces
    assert.strictEqual(leaderHealth.isJailed('alice', N + 2), false)
    assert.strictEqual(leaderHealth.get('alice').jail.probation, false)
})

test('a heartbeat on a healthy account does not arm the probation re-jail', () => {
    reset()
    leaderHealth.processBlock(block(1, 'alice', []), null)
    // an ENABLE_NODE re-sent while healthy (the setup sends one per leader)
    leaderHealth.processBlock(block(2, 'alice', [], [{ type: 18, sender: 'alice' }]), null)
    // its next production must NOT jail it
    leaderHealth.processBlock(block(3, 'alice', []), null)
    assert.strictEqual(leaderHealth.isJailed('alice', 3), false)
    assert.strictEqual(leaderHealth.get('alice').jail, null)
})

console.log('\n--- eligibility ---')

test('a leader with no scheduled turn is not eligible', () => {
    reset()
    leaderHealth.processBlock(block(1, 'alice', []), null)
    assert.strictEqual(leaderHealth.isEligible('bob', 1), false)
})

test('a jailed leader is not eligible', () => {
    reset()
    const N = config.jailMissThreshold || 30
    for (let i = 0; i < N; i++)
        leaderHealth.processBlock(block(i + 1, 'bob', ['alice']), null)
    assert.strictEqual(leaderHealth.isEligible('alice', N), false)
})

test('a produced leader is eligible', () => {
    reset()
    leaderHealth.processBlock(block(1, 'alice', []), { shuffle: [
        { name: 'alice' }, { name: 'bob' }, { name: 'carol' }
    ]})
    assert.strictEqual(leaderHealth.isEligible('alice', 1), true)
})

console.log('\n--- rebuild determinism ---')

test('rebuild from blocks produces the same state as incremental processing', () => {
    reset()
    const blocks = []
    for (let i = 0; i < 35; i++)
        blocks.push(block(i + 1, 'bob', ['alice']))
    for (const b of blocks)
        leaderHealth.processBlock(b, null)
    const inc = JSON.parse(JSON.stringify(leaderHealth.leaders))
    reset()
    leaderHealth.rebuild(blocks, null)
    assert.deepStrictEqual(leaderHealth.leaders, inc)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
