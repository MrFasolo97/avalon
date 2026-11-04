// == Schedule persistence (Layer S/H, F7 restart divergence fix) ==
// node test/schedule-persist.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// Stub globals
if (typeof global.config === 'undefined')
    global.config = {
        leaders: 3,
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    }
if (typeof global.logr === 'undefined')
    global.logr = { warn: () => {}, debug: () => {}, error: () => {}, info: () => {} }

require.cache[require.resolve('../src/logger')] = { exports: global.logr }

const chain = require('../src/chain')

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
    chain.schedulePersistPath = path.join(__dirname, 'schedule-test-' + Date.now() + '.json')
    try { fs.unlinkSync(chain.schedulePersistPath) } catch (e) {}
    chain.getLatestBlock = () => ({ _id: 99, hash: 'head' })
}

function cleanup() {
    try { fs.unlinkSync(chain.schedulePersistPath) } catch (e) {}
}

console.log('=== Schedule persistence ===\n')

test('saveSchedule writes schedule to disk', () => {
    reset()
    chain.schedule = { shuffle: [{ name: 'alice' }, { name: 'bob' }] }
    chain.saveSchedule()
    assert.ok(fs.existsSync(chain.schedulePersistPath))
    cleanup()
})

test('loadSchedule reads back the persisted schedule', () => {
    reset()
    chain.schedule = { shuffle: [{ name: 'alice' }, { name: 'bob' }] }
    chain.saveSchedule()
    const loaded = chain.loadSchedule()
    assert.ok(loaded)
    assert.strictEqual(loaded.height, 99)
    assert.deepStrictEqual(loaded.schedule.shuffle.map(s => s.name), ['alice', 'bob'])
    cleanup()
})

test('loadSchedule returns null for missing file', () => {
    reset()
    const loaded = chain.loadSchedule()
    assert.strictEqual(loaded, null)
    cleanup()
})

test('loadSchedule returns null for corrupted file', () => {
    reset()
    fs.writeFileSync(chain.schedulePersistPath, 'not json')
    const loaded = chain.loadSchedule()
    assert.strictEqual(loaded, null)
    cleanup()
})

cleanup()
console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
