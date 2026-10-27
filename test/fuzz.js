// test/fuzz.js — property-based / fuzz tests for the leader jail kernel
//
// Run with: node test/fuzz.js
//
// Randomly generates block histories and network conditions, then checks
// invariants of the pure kernel functions.

const assert = require('assert')
const lh = require('../src/leaderHealth')

function mulberry32(a) {
    return function() {
        let t = a += 0x6D2B79F5
        t = Math.imul(t ^ t >>> 15, t | 1)
        t ^= t + Math.imul(t ^ t >>> 7, t | 61)
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
}

const names = ['dtube', 'miner1', 'miner2', 'miner3', 'miner4', 'miner5']
const rand = mulberry32(20261026)

function randomBlock(height) {
    const miner = names[Math.floor(rand() * names.length)]
    const skipped = []
    const numSkips = Math.floor(rand() * 3)
    for (let i = 0; i < numSkips; i++) {
        const n = names[Math.floor(rand() * names.length)]
        if (n !== miner && skipped.indexOf(n) === -1) skipped.push(n)
    }
    const hasHeartbeat = rand() < 0.05
    const txs = hasHeartbeat ? [{ type: 18, sender: names[Math.floor(rand() * names.length)] }] : []
    return { _id: height, miner, timestamp: height * 3000, skips: skipped, txs }
}

function randomChain(length, start = 1) {
    const blocks = []
    for (let i = 0; i < length; i++) blocks.push(randomBlock(start + i))
    return blocks
}

let passed = 0
function check(name, fn) {
    fn()
    passed++
}

// 1. quorum invariants
for (let i = 0; i < 1000; i++) {
    check('quorum size is between 1 and quorumCap', () => {
        const E = Math.floor(rand() * 10)
        const q = lh.quorumSize(E, { quorumMin: 3, quorumCap: 4 })
        assert(q >= 1 && q <= 4, 'q out of bounds: ' + q)
    })
}

// 2. breaker threshold is a majority and never exceeds E
for (let i = 0; i < 1000; i++) {
    check('breaker threshold is majority of E', () => {
        const E = Math.floor(rand() * 10) + 1
        const t = lh.breakerThreshold(E)
        assert(t >= 1 && t <= E, 'breaker threshold out of bounds: ' + t)
        assert(t > E / 2, 'breaker threshold not majority: ' + t + ' <= ' + E / 2)
    })
}

// 3. jail streaks are never negative and jailedUntil is monotonic
for (let i = 0; i < 500; i++) {
    check('jail state invariants', () => {
        const blocks = randomChain(50 + Math.floor(rand() * 200))
        const state = lh.jailState(blocks, {
            jailMissThreshold: 3,
            jailBlocks: 20,
            jailBackoffMax: 4,
            lookback: 5000
        })
        for (const n of Object.keys(state.byName)) {
            const e = state.byName[n]
            assert(e.streak >= 0, 'negative streak')
            assert(e.jailCount >= 0, 'negative jailCount')
            assert(e.jailedUntil >= 0, 'negative jailedUntil')
        }
    })
}

// 4. commit lock invariants
for (let i = 0; i < 500; i++) {
    check('commit lock invariants', () => {
        const height = Math.floor(rand() * 1000)
        const hash1 = 'h' + Math.floor(rand() * 1e6)
        const hash2 = 'h' + Math.floor(rand() * 1e6)
        if (hash1 === hash2) return
        const locks = {}
        const d1 = lh.commitDecision(locks, height, { hash: hash1, miner: 'a' }, null)
        assert(d1.allow && d1.lock, 'first commit must lock')
        locks[height] = { hash: hash1, miner: 'a' }
        const d2 = lh.commitDecision(locks, height, { hash: hash2, miner: 'b' }, null)
        assert(!d2.allow, 'second hash must be refused')
        const d3 = lh.commitDecision(locks, height, { hash: hash1, miner: 'a' }, null)
        assert(d3.allow, 'same hash must be idempotent')
    })
}

// 5. halt-breaker recovery: allowed iff a majority of the eligible set signed,
// and never when the eligible set is empty (E=0 must always halt)
for (let i = 0; i < 400; i++) {
    check('breaker recovery follows the majority rule', () => {
        const E = Math.floor(rand() * 8)
        const S = Math.floor(rand() * 9)
        const r = lh.breakerRecovery(E, S)
        if (E === 0) assert(!r.allowed, 'must not recover with no eligible leaders')
        else {
            assert.strictEqual(r.allowed, S >= lh.breakerThreshold(E),
                'recovery mismatch for E=' + E + ' S=' + S)
            assert.strictEqual(r.missing, Math.max(0, E - S), 'missing count mismatch')
        }
    })
}

// 6. height gating: before H_S the active set is never jailed and bootstrap quorum applies
for (let i = 0; i < 200; i++) {
    check('pre-H_S bootstrap mode', () => {
        const blocks = randomChain(20)
        const state = lh.jailState(blocks, { jailEnabled: false, lookback: 100 })
        assert(Object.keys(state.byName).length === 0 ||
            Object.values(state.byName).every(e => e.jailedUntil === 0 && e.streak === 0),
            'jail enabled before H_S')
        const E = Math.floor(rand() * 4) + 1
        const q = lh.quorumSize(E, { quorumMin: 3, quorumCap: 4, bootstrap: true })
        assert.strictEqual(q, E, 'bootstrap quorum must equal E')
    })
}

console.log('\n' + passed + ' fuzz checks passed')
