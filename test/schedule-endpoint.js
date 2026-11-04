// == /schedule additive fields (Layer S/H) ==
// node test/schedule-endpoint.js

const assert = require('assert')

if (typeof global.config === 'undefined')
    global.config = {
        leaders: 5,
        blockTime: 3000,
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    }

if (typeof global.chain === 'undefined')
    global.chain = {
        getLatestBlock: () => ({ _id: 12, hash: 'head' }),
        schedule: { block: { _id: 10, hash: 'seed' }, shuffle: [{ name: 'alice' }, { name: 'bob' }] },
        activeLeaderSet: () => [{ name: 'alice' }, { name: 'carol' }],
        standbyLeaderSet: () => [{ name: 'dave' }]
    }
if (typeof global.logr === 'undefined')
    global.logr = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

// real leaderHealth (pure derived state, required by the endpoint)
const leaderHealth = require('../src/leaderHealth')
leaderHealth.leaders = {
    carol: Object.assign(leaderHealth.emptyLeader(), { produced: 3 }),
    dave: Object.assign(leaderHealth.emptyLeader(), {
        produced: 0, missed: 40, streak: 40,
        jail: { active: true, untilBlock: 500, level: 1, lastJailBlock: 300, probation: false }
    })
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

function mockApp() {
    const routes = {}
    return {
        get: (path, ...handlers) => { routes[path] = handlers[handlers.length - 1] },
        routes: routes
    }
}

function mockRes() {
    return {
        sent: null,
        status() { return this },
        send(obj) { this.sent = obj }
    }
}

console.log('=== /schedule additive fields ===\n')

test('/schedule keeps the legacy shuffle and adds epoch/set/standbys/jailed', () => {
    const mod = require('../src/http/schedule')
    const app = mockApp()
    mod.init(app)
    const res = mockRes()
    app.routes['/schedule']({ query: {} }, res)
    assert.ok(res.sent)
    // legacy field untouched
    assert.deepStrictEqual(res.sent.shuffle.map(s => s.name), ['alice', 'bob'])
    assert.strictEqual(res.sent.epoch, 10) // 12 - (12 % 5)
    assert.deepStrictEqual(res.sent.set, ['alice', 'carol'])
    assert.deepStrictEqual(res.sent.standbys, ['dave'])
    assert.deepStrictEqual(res.sent.jailed, ['dave'])
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
