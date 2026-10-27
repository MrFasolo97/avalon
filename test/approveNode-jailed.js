// test/approveNode-jailed.js — verify approveNode rejects votes for jailed leaders
//
// Run with: node test/approveNode-jailed.js
const assert = require('assert')
const path = require('path')

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        passed++
        console.log('PASS: ' + name)
    } catch (e) {
        failed++
        console.log('FAIL: ' + name + ' — ' + e.message)
    }
}

// Mock globals that approveNode.js expects
const mockChain = {
    getLatestBlock: () => ({ _id: 250 }),
    jailState: () => ({
        jailed: {
            jailedLeader: { until: 300, streak: 5 },
        },
        backoff: {},
    }),
    healthParams: () => ({
        jailEnabled: true,
        H_S: 200,
        H_strict: 200,
        H_standby: 200,
    }),
}

global.chain = mockChain
global.config = {
    accountMaxLength: 32,
    accountMinLength: 1,
    allowedUsernameChars: 'abcdefghijklmnopqrstuvwxyz0123456789',
    allowedUsernameCharsOnlyMiddle: '-.',
    leaderMaxVotes: 5,
    disallowVotingInactiveLeader: true,
    disallowVotingJailedLeader: true,
}
global.logr = { error: () => {}, debug: () => {} }
global.validate = {
    string: (s) => typeof s === 'string' && s.length > 0,
    integer: () => true,
}

// simple in-memory cache mock
const accounts = {
    voter: { name: 'voter', approves: [], balance: 1000 },
    activeLeader: { name: 'activeLeader', pub_leader: 'pub1', node_appr: 100 },
    jailedLeader: { name: 'jailedLeader', pub_leader: 'pub2', node_appr: 100 },
    inactiveLeader: { name: 'inactiveLeader', pub_leader: '', node_appr: 100 },
}

global.cache = {
    findOne: (col, q, cb) => {
        if (col === 'accounts') {
            const name = q.name
            setImmediate(() => cb(null, accounts[name] || null))
        } else {
            setImmediate(() => cb(null, null))
        }
    },
}

const approveNode = require('../src/transactions/approveNode')

function runValidate(tx) {
    return new Promise((resolve) => {
        approveNode.validate(tx, Date.now(), {}, (ok, err) => resolve({ ok, err }))
    })
}

console.log('=== approveNode jailed-leader vote tests ===\n')

test('rejects vote for jailed leader when jailEnabled', async () => {
    const r = await runValidate({ sender: 'voter', data: { target: 'jailedLeader' } })
    assert.strictEqual(r.ok, false, 'expected rejection')
    assert.strictEqual(r.err, 'target is currently jailed')
})

test('allows vote for active leader', async () => {
    const r = await runValidate({ sender: 'voter', data: { target: 'activeLeader' } })
    assert.strictEqual(r.ok, true, 'expected approval')
})

test('still rejects vote for inactive (no pub_leader) leader', async () => {
    const r = await runValidate({ sender: 'voter', data: { target: 'inactiveLeader' } })
    assert.strictEqual(r.ok, false, 'expected rejection')
    assert.strictEqual(r.err, 'target does not have an activated leader signing key')
})

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===')
process.exit(failed > 0 ? 1 : 0)
