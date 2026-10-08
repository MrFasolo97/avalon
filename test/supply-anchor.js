// == Hard fork #13330000: supply-anchored reward pool + vote rate cap + pow determinism ==
// Verifies that the new economics keys only exist at/after the fork height, that the
// fork is unreachable by governance, and that every pre-fork computation is unchanged.

const assert = require('assert')
const path = require('path')
const fs = require('fs')

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

// src/config.js and src/economics.js read their collaborators as globals (set by main.js)
global.logr = new Proxy({}, { get: () => () => {} })
global.cache = { state: {} }

const cfg = require('../src/config.js')
const eco = require('../src/economics.js')

const FORK = 13330000
const ANCHOR_BLOCK = 13320066
const ANCHOR_SUPPLY = 572311976.600145
const WINDOWS_PER_YEAR = 365 * 24 * 3600 * 1000 / (9600 * 3000) // = 1095
const supplyUnits = Math.round(ANCHOR_SUPPLY * 1000)

function resetEco() {
    eco.startRewardPool = null
    eco.lastRewardPool = null
    eco.totalSupplyUnits = null
    eco.currentBlock = { dist: 0, burn: 0, votes: 0 }
    eco.history = []
}

console.log('=== Fork 13330000: config gating ===\n')

test('pre-fork config has none of the new economics keys', () => {
    const pre = cfg.read(FORK - 1)
    assert.strictEqual(pre.rewardPoolYearlyRate, undefined)
    assert.strictEqual(pre.vtReferenceTotal, undefined)
    assert.strictEqual(pre.initialSupplyBlock, undefined)
    assert.strictEqual(pre.initialSupply, undefined)
})

test('fork block config carries all four new keys', () => {
    const post = cfg.read(FORK)
    assert.strictEqual(post.rewardPoolYearlyRate, 0.10)
    assert.strictEqual(post.vtReferenceTotal, 15500000)
    assert.strictEqual(post.initialSupplyBlock, ANCHOR_BLOCK)
    assert.strictEqual(post.initialSupply, ANCHOR_SUPPLY)
})

test('fork keys still apply well after the fork height', () => {
    const post = cfg.read(FORK + 1000)
    assert.strictEqual(post.rewardPoolYearlyRate, 0.10)
    assert.strictEqual(post.vtReferenceTotal, 15500000)
})

test('planned 13925000 fork (forceFinalize/consensusSigVersion) is untouched', () => {
    const hf = cfg.read(13925000)
    assert.strictEqual(hf.forceFinalize, true)
    assert.strictEqual(hf.consensusSigVersion, 2)
    // it inherits the economics fork instead of shadowing it
    assert.strictEqual(hf.rewardPoolYearlyRate, 0.10)
})

test('governance cannot override the supply anchor', () => {
    global.cache = { state: { 1: {
        initialSupply: { value: 1, effectiveBlock: FORK },
        initialSupplyBlock: { value: 2, effectiveBlock: FORK },
        rewardPoolAmount: { value: 999999, effectiveBlock: FORK }
    } } }
    const gov = cfg.read(FORK)
    assert.strictEqual(gov.rewardPoolAmount, 999999, 'ordinary governance keys still work')
    assert.strictEqual(gov.initialSupply, ANCHOR_SUPPLY, 'initialSupply must not be overridable')
    assert.strictEqual(gov.initialSupplyBlock, ANCHOR_BLOCK, 'initialSupplyBlock must not be overridable')
    global.cache = { state: {} }
})

console.log('\n=== Fork 13330000: reward pool sizing ===\n')

test('pre-fork pool stays the fixed 150001 constant', () => {
    resetEco()
    global.config = cfg.read(FORK - 1)
    assert.strictEqual(eco.rewardPool().theo, 150001)
})

test('post-fork pool = totalSupply * rewardPoolYearlyRate / windowsPerYear', () => {
    resetEco()
    global.config = cfg.read(FORK + 1)
    eco.totalSupplyUnits = supplyUnits
    const theo = eco.rewardPool().theo
    const expected = Math.round((supplyUnits / 1000 * 0.10 / WINDOWS_PER_YEAR) * 1000) / 1000
    assert.strictEqual(WINDOWS_PER_YEAR, 1095)
    assert.strictEqual(theo, expected)
    assert.ok(theo > 52000 && theo < 52500, 'expected ~52.2k DTC/window, got ' + theo)
})

test('pool shrinks with supply (percentage, not constant)', () => {
    resetEco()
    global.config = cfg.read(FORK + 1)
    eco.totalSupplyUnits = supplyUnits
    const full = eco.rewardPool().theo
    eco.totalSupplyUnits = Math.round(supplyUnits / 2)
    const half = eco.rewardPool().theo
    assert.ok(half < full * 0.51, 'halving supply must roughly halve the pool')
})

test('missing accumulator is fatal instead of a silent fork', () => {
    resetEco()
    global.config = cfg.read(FORK + 1)
    eco.totalSupplyUnits = null
    let fatal = false
    const realFatal = global.logr
    global.logr = new Proxy({}, { get: (t, k) => k === 'fatal' ? () => { fatal = true } : () => {} })
    const realExit = process.exit
    process.exit = (code) => { throw new Error('exit:' + code) }
    try {
        eco.rewardPool()
    } catch (e) {
        assert.ok(fatal, 'logr.fatal must be called')
        assert.strictEqual(e.message, 'exit:1')
    } finally {
        process.exit = realExit
        global.logr = realFatal
    }
    assert.ok(fatal, 'rewardPool must refuse to size the pool without an accumulator')
})

console.log('\n=== Fork 13330000: single-vote rate cap ===\n')

function preparePool(theoVotes) {
    eco.startRewardPool = { burn: 0, dist: 0, votes: theoVotes, theo: 0, avail: 0 }
    eco.currentBlock = { dist: 0, burn: 0, votes: 0 }
    eco.history = []
    return eco.rewardPool()
}

test('pre-fork: no rate cap, whale vote scales with the fixed pool', () => {
    resetEco()
    global.config = cfg.read(FORK - 1)
    const stats = preparePool(1000000)
    assert.strictEqual(stats.avail, 150001)
    const value = eco.print(5000)
    assert.ok(value > 700 && value < 800, 'expected ~750 DTC, got ' + value)
})

test('post-fork: whale vote on a quiet network is capped to pool*vt/vtReferenceTotal', () => {
    resetEco()
    global.config = cfg.read(FORK + 1)
    eco.totalSupplyUnits = supplyUnits
    const stats = preparePool(1000000)
    const uncapped = eco.floor(stats.theo * 5000 / 1000000)
    const cap = stats.theo * 5000 / 15500000
    const value = eco.print(5000)
    assert.ok(uncapped > 200, 'uncapped payout should be large, got ' + uncapped)
    assert.ok(value < 20, 'capped payout must be tiny, got ' + value)
    assert.ok(Math.abs(value - cap) < 0.01, 'expected ' + cap + ', got ' + value)
    assert.ok(value < uncapped / 10, 'rate cap must cut the payout by >10x')
})

test('post-fork: first vote on a dead network prints dust (was 1)', () => {
    resetEco()
    global.config = cfg.read(FORK - 1)
    preparePool(0)
    assert.strictEqual(eco.print(1), 1, 'pre-fork minimum is 1 DTC')

    resetEco()
    global.config = cfg.read(FORK + 1)
    eco.totalSupplyUnits = supplyUnits
    preparePool(0)
    const first = eco.print(1)
    assert.ok(first < 0.01, 'post-fork first vote must be dust, got ' + first)
    assert.ok(first <= eco.rewardPool().theo / 15500000, 'still bounded by the rate cap')
})

test('rate cap never exceeds the pool share backstop', () => {
    resetEco()
    global.config = cfg.read(FORK + 1)
    eco.totalSupplyUnits = supplyUnits
    const stats = preparePool(1000000)
    const value = eco.print(500000000) // absurd vote on an inactive network
    assert.ok(value <= Math.floor(stats.avail * 0.1), 'rewardPoolMaxShare backstop still holds')
    assert.ok(value <= Math.floor(stats.theo * 500000000 / 15500000) + 0.001, 'rate cap holds')
})

console.log('\n=== Fork 13330000: numeric determinism (pow10/ipow) ===\n')

test('pow10 is bit-identical to Math.pow(10, p) for every precision in use', () => {
    for (const p of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 22])
        assert.strictEqual(eco.pow10(p), Math.pow(10, p), 'pow10(' + p + ')')
})

test('round/floor unchanged (pow10 swap is behaviour-neutral)', () => {
    global.config = cfg.read(FORK - 1)
    const prec = Math.pow(10, config.ecoClaimPrecision)
    for (const v of [0, 1.0005, 0.0001, 12345.6789, -1.5, 1e9])
        assert.strictEqual(eco.round(v), Math.round(v * prec) / prec, 'round(' + v + ')')
    for (const v of [0, 1.0005, 0.0001, 12345.6789, -1.5])
        assert.strictEqual(eco.floor(v), Math.floor(v * prec) / prec, 'floor(' + v + ')')
})

test('accountPrice: Math.pow pre-fork, ipow post-fork', () => {
    global.config = cfg.read(FORK - 1)
    const pre = eco.accountPrice('abc')
    const expectedPre = Math.round((config.accountPriceBase - config.accountPriceMin)
        * Math.pow(config.accountPriceChars / 3, config.accountPriceCharMult)) + config.accountPriceMin
    assert.strictEqual(pre, expectedPre)

    global.config = cfg.read(FORK + 1)
    const post = eco.accountPrice('abc')
    const expectedPost = Math.round((config.accountPriceBase - config.accountPriceMin)
        * eco.ipow(config.accountPriceChars / 3, config.accountPriceCharMult)) + config.accountPriceMin
    assert.strictEqual(post, expectedPost)
})

test('ipow only accepts integer exponents (the gated case)', () => {
    assert.strictEqual(eco.ipow(1.5, 4), 1.5 * 1.5 * 1.5 * 1.5)
    assert.strictEqual(eco.ipow(2, 0), 1)
    assert.strictEqual(eco.ipow(0.5, 3), 0.125)
})

console.log('\n=== Fork 13330000: integration (source-level) ===\n')

function src(rel) {
    return fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')
}

test('economics.js has no remaining Math.pow(10, ...)', () => {
    const code = src('economics.js').split('\n')
        .filter(l => !l.trim().startsWith('//')).join('\n')
    assert.ok(!/Math\.pow\(\s*10\s*,/.test(code), 'all pow(10, n) must go through eco.pow10')
})

test('economics.js keeps the votes===0 -> 1 branch (no pre-fork behaviour change)', () => {
    assert.ok(src('economics.js').includes('thNewCoins = 1'))
})

test('chain.js implements scanSupply and accumulates in chain.output', () => {
    const c = src('chain.js')
    assert.ok(c.includes('scanSupply: (from, to, cb)'), 'scanSupply method missing')
    assert.ok(c.includes('$lte: to'), 'mongo range query missing')
    assert.ok(c.includes('eco.totalSupplyUnits += Math.round((block.dist || 0) * 1000)'), 'increment missing')
    assert.ok(c.indexOf('totalSupplyUnits') < c.indexOf('chain.nextOutput.txs += block.txs.length'),
        'accumulator must be updated at the top of chain.output')
})

test('cache.js persists totalSupplyUnits alongside headBlock', () => {
    assert.ok(src('cache.js').includes('totalSupplyUnits: eco.totalSupplyUnits'))
})

test('main.js restores then re-scans the accumulator (self-healing)', () => {
    const m = src('main.js')
    assert.ok(m.includes('function bootstrapSupply'), 'bootstrap helper missing')
    assert.ok(m.includes('state.totalSupplyUnits'), 'state restore missing')
    assert.ok(m.includes('bootstrapSupply(block._id, startDaemon)'), 'daemon warmup missing')
    assert.ok(m.includes('bootstrapSupply(startBlock - 1'), 'rebuild warmup missing')
})

test('config.js anchor keys are filtered out of allowedKeys', () => {
    const c = src('config.js')
    assert.ok(c.includes("k !== 'initialSupply' && k !== 'initialSupplyBlock'"))
})

test('out-of-scope consensus code is untouched (fork #2 territory)', () => {
    const d = src('decayInt.js')
    assert.ok(d.includes('Math.log') || d.includes('Math.exp'),
        'decayInt.js must stay as-is until a dedicated fork')
})

test('math in validate/float.js, tippedVote.js and chain.js rounding untouched', () => {
    assert.ok(src('validate/float.js').includes('Math.pow(2,33)'))
    assert.ok(src('transactions/tippedVote.js').includes('Math.pow(10,'))
})

// Summary
console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===')
process.exit(failed > 0 ? 1 : 0)
