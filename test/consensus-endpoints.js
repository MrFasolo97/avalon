// == HTTP endpoints /consensus and /debug/statehash (Layer S/H) ==
// node test/consensus-endpoints.js

const assert = require('assert')

// Stub globals
if (typeof global.config === 'undefined')
    global.config = {
        blockTime: 3000,
        leaders: 3,
        maxDrift: 5000,
        forceFinalize: true,
        skipRecording: true,
        skipStrict: false,
        haltBreaker: true,
        standbyEnabled: false,
        canonicalLeaderOrder: false
    }
if (typeof global.chain === 'undefined')
    global.chain = {
        getLatestBlock: () => ({ _id: 100, hash: 'head', phash: 'prev', timestamp: 1000000 }),
        recentBlocks: [
            { _id: 99, hash: 'b99', miner: 'alice' },
            { _id: 100, hash: 'head', miner: 'bob', skips: ['alice'] }
        ],
        schedule: { shuffle: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }] }
    }
if (typeof global.consensus === 'undefined')
    global.consensus = {
        observer: false,
        possBlocks: [
            {
                block: { _id: 101, hash: 'p1', miner: 'alice', timestamp: 1003000, skips: [] },
                0: ['alice'],
                1: ['alice', 'bob']
            }
        ],
        queue: [],
        activeLeaders: () => ['alice', 'bob', 'carol'],
        eligibleLeaders: () => ['alice', 'bob'],
        _getQuorumThreshold: () => 2
    }
// /consensus requires the real leaderHealth module (it is pure derived state,
// not a global like chain/consensus), so seed that instead of a stub.
if (typeof global.leaderHealth === 'undefined') {
    const lh = require('../src/leaderHealth')
    lh.leaders = {
        alice: Object.assign(lh.emptyLeader(), { produced: 10, missed: 0 }),
        bob: Object.assign(lh.emptyLeader(), { produced: 5, missed: 1 })
    }
}
if (typeof global.logr === 'undefined')
    global.logr = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

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
        statusCode: 200,
        status(c) { this.statusCode = c; return this },
        send(obj) { this.sent = obj }
    }
}

console.log('=== Consensus HTTP endpoints ===\n')

test('/consensus returns current state snapshot', () => {
    const consensusModule = require('../src/http/consensus')
    const app = mockApp()
    consensusModule.init(app)
    const res = mockRes()
    app.routes['/consensus']({}, res)
    assert.ok(res.sent)
    assert.strictEqual(res.sent.height, 100)
    assert.strictEqual(res.sent.nextHeight, 101)
    assert.strictEqual(res.sent.eligibleCount, 2)
    assert.strictEqual(res.sent.quorumThreshold, 2)
    assert.strictEqual(res.sent.possBlocksCount, 1)
    assert.strictEqual(res.sent.possBlocks[0].hash, 'p1')
    assert.strictEqual(res.sent.leaderHealth.alice.produced, 10)
    assert.strictEqual(res.sent.flags.forceFinalize, true)
})

test('/debug/statehash returns a deterministic sha256', () => {
    const debugModule = require('../src/http/debug')
    const app = mockApp()
    debugModule.init(app)
    const res = mockRes()
    app.routes['/debug/statehash']({}, res)
    assert.ok(res.sent)
    assert.strictEqual(res.sent.height, 100)
    assert.ok(typeof res.sent.stateHash === 'string')
    assert.strictEqual(res.sent.stateHash.length, 64)
    assert.ok(res.sent.inputs)
    assert.deepStrictEqual(res.sent.inputs.activeLeaders, ['alice', 'bob', 'carol'])
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
