// == Skip attestation logic (Layer S/H) ==
// node test/skip-attestation.js
//
// These are pure functions that mirror chain.js logic without loading the full
// chain module (which needs globals). They assert that the canonical skip prefix
// is exactly the ladder prefix preceding the producer.

const assert = require('assert')

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

function ladder(schedule, recentMiners, height, L) {
    const out = []
    const s = schedule[(height - 1) % L]
    if (s && out.indexOf(s) === -1) out.push(s)
    for (let i = 1; i <= L; i++) {
        const m = recentMiners[recentMiners.length - i]
        if (!m) break
        if (out.indexOf(m) === -1) out.push(m)
    }
    return out
}

function expectedSkips(ladder, miner) {
    const pos = ladder.indexOf(miner)
    return pos > 0 ? ladder.slice(0, pos) : []
}

console.log('=== Skip attestation ===\n')

const L = 5
const schedule = ['A', 'B', 'C', 'D', 'E']

test('scheduled leader produces → empty skips', () => {
    const recent = ['X', 'Y', 'Z', 'W', 'V']
    const h = 1
    const ld = ladder(schedule, recent, h, L)
    assert.deepStrictEqual(ld, ['A', 'V', 'W', 'Z', 'Y', 'X'])
    assert.deepStrictEqual(expectedSkips(ld, 'A'), [])
})

test('first backup produces → skips the scheduled leader', () => {
    const recent = ['X', 'Y', 'Z', 'W', 'V']
    const h = 1
    const ld = ladder(schedule, recent, h, L)
    assert.deepStrictEqual(expectedSkips(ld, 'V'), ['A'])
})

test('second backup produces → skips scheduled + first backup', () => {
    const recent = ['X', 'Y', 'Z', 'W', 'V']
    const h = 1
    const ld = ladder(schedule, recent, h, L)
    assert.deepStrictEqual(expectedSkips(ld, 'W'), ['A', 'V'])
})

test('ladder deduplicates recent miners', () => {
    const recent = ['A', 'A', 'B', 'B', 'C']
    const h = 6
    const ld = ladder(schedule, recent, h, L)
    assert.deepStrictEqual(ld, ['A', 'C', 'B'])
})

test('skips array is the canonical prefix; any deviation is wrong', () => {
    const recent = ['X', 'Y', 'Z', 'W', 'V']
    const h = 1
    const ld = ladder(schedule, recent, h, L)
    const good = expectedSkips(ld, 'W') // ['A','V']
    const bad1 = ['A', 'B']
    const bad2 = ['V', 'A']
    assert.ok(good.length === bad1.length && good.every((n, i) => n === bad1[i]) === false)
    assert.ok(good.length === bad2.length && good.every((n, i) => n === bad2[i]) === false)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
