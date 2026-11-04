// == Structured event log (src/events.js) ==
// node test/events.js

// Small buffer so the ring-cap behaviour is testable.
process.env.EVENT_BUFFER_MAX = '3'

const assert = require('assert')
const events = require('../src/events')

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

console.log('=== structured events ===')

test('emit increments head and returns a structured event', () => {
    events._reset()
    const e = events.emit('jail', 'warn', { leader: 'alice' })
    assert.strictEqual(e.seq, 1)
    assert.strictEqual(e.type, 'jail')
    assert.strictEqual(e.level, 'warn')
    assert.deepStrictEqual(e.data, { leader: 'alice' })
    assert.strictEqual(events.head(), 1)
})

test('level defaults to info and unknown levels are normalised', () => {
    events._reset()
    assert.strictEqual(events.emit('a').level, 'info')
    assert.strictEqual(events.emit('b', 'debug').level, 'info') // only warn/error kept
    assert.strictEqual(events.emit('c', 'error').level, 'error')
})

test('ring buffer keeps only the last EVENT_BUFFER_MAX events', () => {
    events._reset()
    for (let i = 0; i < 5; i++) events.emit('x', 'info', { i: i })
    const all = events.list({ limit: 100 })
    assert.strictEqual(all.length, 3)
    assert.deepStrictEqual(all.map(e => e.data.i), [2, 3, 4])
})

test('list returns oldest-first and respects since', () => {
    events._reset()
    const a = events.emit('a')
    const b = events.emit('b')
    events.emit('c')
    const all = events.list({ limit: 100 })
    assert.deepStrictEqual(all.map(e => e.seq), [1, 2, 3])
    const afterA = events.list({ since: a.seq, limit: 100 })
    assert.deepStrictEqual(afterA.map(e => e.seq), [b.seq, 3])
})

test('list filters by type (string or comma list)', () => {
    events._reset()
    events.emit('jail')
    events.emit('halt-breaker-fired')
    events.emit('jail')
    assert.strictEqual(events.list({ type: 'jail', limit: 100 }).length, 2)
    assert.strictEqual(events.list({ type: 'halt-breaker-fired', limit: 100 }).length, 1)
    assert.strictEqual(events.list({ type: 'jail,halt-breaker-fired', limit: 100 }).length, 3)
})

test('list limit caps the returned count', () => {
    events._reset()
    for (let i = 0; i < 3; i++) events.emit('x')
    assert.strictEqual(events.list({ limit: 2 }).length, 2)
})

test('snapshot exposes counters and last timestamps', () => {
    events._reset()
    events.emit('jail')
    events.emit('jail')
    events.emit('force-finalize')
    const s = events.snapshot()
    assert.strictEqual(s.head, 3)
    assert.strictEqual(s.counters['jail'], 2)
    assert.strictEqual(s.counters['force-finalize'], 1)
    assert.ok(s.lastTs['jail'] > 0)
})

test('emit never throws, even on bad input', () => {
    events._reset()
    assert.doesNotThrow(() => events.emit(null, 'warn', undefined))
    // data defaults to {}
    const e = events.emit('x')
    assert.deepStrictEqual(e.data, {})
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED')
    + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
