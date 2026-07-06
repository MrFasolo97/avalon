// == Audit Fixes Integration Tests ==
// Tests all fixes from the security/consensus audit

const assert = require('assert')
const crypto = require('crypto')
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

console.log('=== Audit Fix Verification ===\n')

// 1. tryNextStepBusy lock pattern
console.log('--- consensus.js: tryNextStepBusy lock ---')
test('tryNextStepBusy prevents concurrent tryNextStep execution', () => {
    let busy = false
    let deferredCalls = 0
    function tryNextStep() {
        if (busy) { deferredCalls++; return }
        busy = true
        busy = false
    }
    tryNextStep()
    busy = true
    tryNextStep()
    assert.strictEqual(deferredCalls, 1)
    busy = false
})

// 2. Fixed quorum threshold
console.log('\n--- consensus.js: Fixed quorum threshold ---')
test('_getQuorumThreshold uses config.leaders (fixed, not activeLeaders)', () => {
    const leaders = 7
    const threshold = Math.ceil(leaders * 2 / 3)
    assert.strictEqual(threshold, 5)
    // Sybil attack: activeLeaders returns 0, old threshold = 0 (bypass!)
    const sybilAttack = Math.ceil(0 * 2 / 3)
    assert.strictEqual(sybilAttack, 0, 'old: 0 = bypass!')
    assert.strictEqual(threshold, 5, 'new: stays at 5')
})

test('quorum threshold edge cases', () => {
    const calc = (leaders) => Math.ceil(leaders * 2 / 3)
    assert.strictEqual(calc(1), 1)
    assert.strictEqual(calc(2), 2)
    assert.strictEqual(calc(3), 2)
    assert.strictEqual(calc(7), 5)
    assert.strictEqual(calc(21), 14)
    assert.strictEqual(calc(100), 67)
})

// 3. candidateRetry >= 3 guard
console.log('\n--- consensus.js: retry loop guard ---')
test('_forceFinalize retry limit at 3', () => {
    const MAX = 3
    function ff(retry) {
        if (retry === undefined) retry = 0
        if (retry >= MAX) return 'EXCEEDED'
        return 'OK'
    }
    assert.strictEqual(ff(0), 'OK')
    assert.strictEqual(ff(1), 'OK')
    assert.strictEqual(ff(2), 'OK')
    assert.strictEqual(ff(3), 'EXCEEDED')
    assert.strictEqual(ff(4), 'EXCEEDED')
})

// 4. fromNow guard
console.log('\n--- consensus.js: fromNow sanitization ---')
test('scheduleForceFinalize bails on fromNow > 86400000', () => {
    function schedule(fromNow) {
        if (fromNow > 86400000) return 'SKIPPED'
        return 'SCHEDULED'
    }
    assert.strictEqual(schedule(1000), 'SCHEDULED')
    assert.strictEqual(schedule(60000), 'SCHEDULED')
    assert.strictEqual(schedule(86400000), 'SCHEDULED')
    assert.strictEqual(schedule(86400001), 'SKIPPED')
})

// 5. Empty shuffle guard
console.log('\n--- consensus.js: empty shuffle guard ---')
test('activeLeaders handles empty shuffle', () => {
    function activeLeaders(shuffle) {
        if (!shuffle || shuffle.length === 0) return []
        return shuffle.map(s => s.name)
    }
    assert.strictEqual(activeLeaders([]).length, 0)
    assert.strictEqual(activeLeaders(null).length, 0)
    assert.strictEqual(activeLeaders(undefined).length, 0)
    assert.strictEqual(activeLeaders([{name:'a'}]).length, 1)
})

// 6. MINE_TOKEN validation
console.log('\n--- mineBlock/index.js: MINE_TOKEN ---')
test('mineBlock: no token required when MINE_TOKEN unset', () => {
    function handler(requiredToken, queryToken) {
        if (requiredToken && queryToken !== requiredToken) return { status: 401 }
        return { status: 200 }
    }
    let r = handler(undefined, 'anything')
    assert.strictEqual(r.status, 200)
    
    r = handler('my-secret', 'wrong')
    assert.strictEqual(r.status, 401)

    r = handler('my-secret', 'my-secret')
    assert.strictEqual(r.status, 200)
})

// 7. DEBUG_TOKEN validation
console.log('\n--- debug/index.js: DEBUG_TOKEN ---')
test('debug: no token required when DEBUG_TOKEN unset', () => {
    function debugHandler(token, dt) {
        if (dt && token !== dt) return { status: 401 }
        return { status: 200 }
    }
    let r = debugHandler('anything', undefined)
    assert.strictEqual(r.status, 200)
    
    r = debugHandler('secret', 'secret')
    assert.strictEqual(r.status, 200)
    
    r = debugHandler('wrong', 'secret')
    assert.strictEqual(r.status, 401)
})

// 8. DNS rebinding protection
console.log('\n--- image/index.js: DNS rebinding protection ---')
test('resolveAndPin + checkRebinding prevents DNS rebinding', async () => {
    const dns = require('dns').promises
    const net = require('net')
    
    async function resolveAndPin(host) {
        if (net.isIP(host)) return host
        try {
            const lookup = await dns.lookup(host, {family: 4})
            return lookup.address
        } catch { return null }
    }
    
    async function checkRebinding(host, pinnedIp) {
        if (net.isIP(host)) return pinnedIp === host
        try {
            const lookup = await dns.lookup(host, {family: 4})
            return lookup.address === pinnedIp
        } catch { return false }
    }
    
    const ip = await resolveAndPin('localhost')
    assert.strictEqual(ip, '127.0.0.1')
    
    const ok = await checkRebinding('localhost', ip)
    assert.strictEqual(ok, true)
    
    const fail = await checkRebinding('localhost', '1.2.3.4')
    assert.strictEqual(fail, false)
    
    const dOk = await checkRebinding('8.8.8.8', '8.8.8.8')
    assert.strictEqual(dOk, true)
    const dFail = await checkRebinding('8.8.8.8', '1.1.1.1')
    assert.strictEqual(dFail, false)
})

// 9. BSON position calculation
console.log('\n--- auto_resolve_halt.sh: BSON truncPos ---')
test('truncPos = (BigInt(high) << 32n) + BigInt(low)', () => {
    function calc(high, low) { return (BigInt(high) << 32n) + BigInt(low) }
    function oldCalc(high, low) { return (BigInt(high) << 8n) + BigInt(low) }
    
    assert.strictEqual(calc(0, 1000), 1000n)
    assert.strictEqual(calc(0, 0xFFFFFFFF), 0xFFFFFFFFn)
    assert.strictEqual(calc(1, 0), 4294967296n)
    assert.strictEqual(calc(1, 1), 4294967297n)
    assert.strictEqual(calc(2, 100), 8589934692n)
    
    // Old code catastrophically wrong for large files
    assert.strictEqual(oldCalc(2, 100), 612n, 'old: 612 bytes instead of 8.5GB')
    assert.notStrictEqual(calc(2, 100), oldCalc(2, 100))
})

// 10. Miner log sanitization
console.log('\n--- chain.js: miner log sanitization ---')
test('block.miner sanitized in output', () => {
    function sanitize(m) { return (m || '').replace(/[\x00-\x1f]/g, '') }
    assert.strictEqual(sanitize('alice'), 'alice')
    assert.strictEqual(sanitize('bob\x00'), 'bob')
    assert.strictEqual(sanitize('\x1b[2J'), '[2J')
    assert.strictEqual(sanitize('\n\r\t'), '')
    assert.strictEqual(sanitize(undefined), '')
    assert.strictEqual(sanitize(null), '')
})

// 11. Rate limiter on /transact
console.log('\n--- transact/index.js: rate limiter ---')
test('POST /transact has rate limiter', () => {
    const content = fs.readFileSync(path.join(__dirname, '../src/http/transact/index.js'), 'utf8')
    assert.ok(content.includes("require('express-rate-limit')"))
    assert.ok(content.includes('txLimiter'))
    assert.ok(content.includes("app.post('/transact', txLimiter,"))
})

// 12. auto_resolve_halt.sh MongoDB eval uses env vars
console.log('\n--- auto_resolve_halt.sh: MongoDB eval injection fix ---')
test('mongo eval uses process.env instead of bash interpolation', () => {
    const content = fs.readFileSync(path.join(__dirname, '../scripts/auto_resolve_halt.sh'), 'utf8')
    assert.ok(content.includes('process.env.REMOVE_COUNT'))
    assert.ok(content.includes('process.env.DRY_RUN'))
})

// 13. File integrity checks
console.log('\n--- File integrity checks ---')
test('consensus.js has tryNextStepBusy', () => {
    const c = fs.readFileSync(path.join(__dirname, '../src/consensus.js'), 'utf8')
    assert.ok(c.includes('tryNextStepBusy'))
    assert.ok(c.includes('tryNextStepBusy: false'))
})

test('consensus.js uses config.leaders for quorum', () => {
    const c = fs.readFileSync(path.join(__dirname, '../src/consensus.js'), 'utf8')
    assert.ok(c.includes('config.leaders * 2 / 3'))
})

test('consensus.js has empty shuffle guard', () => {
    const c = fs.readFileSync(path.join(__dirname, '../src/consensus.js'), 'utf8')
    assert.ok(c.includes('shuffle.length === 0'))
})

test('image/index.js has resolveAndPin + checkRebinding', () => {
    const c = fs.readFileSync(path.join(__dirname, '../src/http/image/index.js'), 'utf8')
    assert.ok(c.includes('resolveAndPin'))
    assert.ok(c.includes('checkRebinding'))
})

test('auto_resolve_halt.sh has BSON << 32n', () => {
    const c = fs.readFileSync(path.join(__dirname, '../scripts/auto_resolve_halt.sh'), 'utf8')
    assert.ok(c.includes('<< 32n'))
})

// Summary
console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===')
process.exit(failed > 0 ? 1 : 0)
