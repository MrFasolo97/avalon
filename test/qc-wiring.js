// == S0' wiring canary ==
// node test/qc-wiring.js
//
// consensus.js depends on globals (config, logr, chain, p2p, cache, dao...) so
// the plain unit tests cannot load it — and that is exactly how a typo like
// `consensus.qc.qcEligible` reached a testnet and crashed a node at genesis.
// This test stubs the globals, loads the REAL module and calls the shadow path.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

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

// Runs a snippet in a clean child process with the globals consensus.js needs.
// Returns { ok, out, err } where out is the parsed JSON printed by the snippet.
function runChild(extraEnv, body) {
    const prelude = `
        const path = require('path')
        const root = ${JSON.stringify(path.join(__dirname, '..'))}
        const logs = []
        global.config = {
            b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
            leaders: 5,
            consensusRounds: 2,
            consensusSigVersion: 2,
            blockTime: 3000,
            maxDrift: 200,
            forceFinalize: false,
            forceFinalizeFallback: false,
            read: () => global.config
        }
        const leader = (n) => ({ name: n, pub_leader: 'pub-' + n })
        global.chain = {
            schedule: { shuffle: ['l1','l2','l3','l4','l5'].map(leader) },
            recentBlocks: ['l5','l4','l3','l2','l1'].map(n => ({ miner: n })),
            getLatestBlock: () => ({ _id: 0, hash: 'genesis', timestamp: 1601477849000 })
        }
        global.p2p = {
            broadcast: () => {},
            broadcastNotSent: () => {},
            recordBlockFailure: () => {}
        }
        global.cache = { state: { 1: {} } }
        global.dao = { resetID: () => {} }
        global.daoMaster = { resetID: () => {} }
        global.logr = {
            info: (m) => logs.push(['info', String(m)]),
            warn: (m) => logs.push(['warn', String(m)]),
            error: (m) => logs.push(['error', String(m)]),
            debug: (m) => logs.push(['debug', String(m)]),
            cons: (m) => logs.push(['cons', String(m)]),
            fatal: (m) => logs.push(['fatal', String(m)]),
            econ: (m) => logs.push(['econ', String(m)])
        }
        const out = (v) => process.stdout.write(JSON.stringify({ value: v, logs }))
    `
    const script = prelude + '\n' + body
    const res = spawnSync(process.execPath, ['-e', script], {
        env: Object.assign({}, process.env, extraEnv),
        encoding: 'utf8'
    })
    if (res.status !== 0)
        throw new Error('child exited ' + res.status + ': ' + (res.stderr || '').split('\n').slice(0, 6).join(' | '))
    return JSON.parse(res.stdout)
}

const voteStateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-qc-wiring-')), 'vote_state.json')
const shadowEnv = { QC_SHADOW: '1', VOTE_STATE_PATH: voteStateFile, NODE_OWNER: 'l1' }
const offEnv = { VOTE_STATE_PATH: voteStateFile, NODE_OWNER: 'l1' }

console.log('=== S0\' wiring canary ===\n')

console.log('--- the module loads and exposes the whole shadow surface ---')

const surface = runChild(shadowEnv, `
    process.env.QC_SHADOW = '1'
    const consensus = require(path.join(root, 'src', 'consensus'))
    const names = ['qcEligible','qcObserve','qcNoteOwnVote','qcCompare','qcHeightOf','qcGuard','activeLeaders','endRound','remoteRoundConfirm','tryNextStep']
    const missing = names.filter(n => typeof consensus[n] !== 'function')
    out({ enabled: consensus.qc.enabled, missing, counters: Object.keys(consensus.qc).length })
`)

test('requires cleanly and QC_SHADOW=1 enables the shadow', () => {
    assert.strictEqual(surface.value.enabled, true)
})

test('every method the shadow path calls exists (the genesis crash)', () => {
    assert.deepStrictEqual(surface.value.missing, [])
})

console.log('\n--- the shadow path actually runs ---')

const behaviour = runChild(shadowEnv, `
    process.env.QC_SHADOW = '1'
    const consensus = require(path.join(root, 'src', 'consensus'))

    // 1. eligible set from activeLeaders(), canonically sorted
    const eligible = consensus.qcEligible(1)

    // 2. a self vote is recorded and persisted before broadcast
    consensus.qcNoteOwnVote(1, 0, 'block-hash-1')
    consensus.qcObserve(1, 0, 'block-hash-1', 'l1')
    const selfCount = require(path.join(root, 'src', 'consensusQuorum'))
        .hasQC(consensus.qc.ledger, 1, 0, 'block-hash-1', eligible)

    // 3. a remote vote
    consensus.qcObserve(1, 1, 'block-hash-1', 'l2')

    // 4. height lookup for a hash-only block (how remote votes arrive)
    consensus.possBlocks = [{ block: { _id: 7, hash: 'h7' }, 0: [], 1: [] }]
    const height = consensus.qcHeightOf({ hash: 'h7' })

    // 5. the comparison itself returns a verdict object
    const cmp = consensus.qcCompare(1, 1, 'block-hash-1', 1, 4)

    out({
        eligible,
        selfCount: selfCount.count,
        height,
        cmpIsObject: cmp !== null && typeof cmp === 'object',
        quorum: cmp && cmp.quorum,
        voteStateWritten: require('fs').existsSync(${JSON.stringify(voteStateFile)}),
        internalErrors: consensus.qc.internalErrors
    })
`)

test('eligible set comes from the chain and is sorted', () => {
    assert.deepStrictEqual(behaviour.value.eligible, ['l1', 'l2', 'l3', 'l4', 'l5'])
})

test('self vote is recorded (it is in the eligible set)', () => {
    assert.strictEqual(behaviour.value.selfCount, 1)
})

test('vote state is persisted before the vote would be broadcast', () => {
    assert.strictEqual(behaviour.value.voteStateWritten, true)
})

test('height is recovered for a hash-only block', () => {
    assert.strictEqual(behaviour.value.height, 7)
})

test('qcCompare returns a verdict and computes the unified quorum', () => {
    assert.strictEqual(behaviour.value.cmpIsObject, true)
    assert.strictEqual(behaviour.value.quorum, 4)
})

test('no internal error was swallowed', () => {
    assert.strictEqual(behaviour.value.internalErrors, 0)
})

console.log('\n--- defect F2: eligible() is a local view, not a chain fact ---')

const f2 = runChild(shadowEnv, `
    process.env.QC_SHADOW = '1'
    const consensus = require(path.join(root, 'src', 'consensus'))
    const full = consensus.qcEligible(1)
    // a node that has not seen the recent leaders yet (fresh boot, partition)
    chain.recentBlocks = []
    const shrunk = consensus.qcEligible(2)
    out({ full, shrunk })
`)

test('an empty recentBlocks view silently shrinks eligible() (defect F2)', () => {
    assert.deepStrictEqual(f2.value.full, ['l1', 'l2', 'l3', 'l4', 'l5'])
    assert.deepStrictEqual(f2.value.shrunk, ['l1'])
})

console.log('\n--- the guard: shadow code can never kill the node ---')

const guard = runChild(shadowEnv, `
    process.env.QC_SHADOW = '1'
    const consensus = require(path.join(root, 'src', 'consensus'))
    const returned = consensus.qcGuard('boom', () => { throw new Error('kaboom') })
    const after = consensus.qcGuard('still-alive', () => 42)
    out({ returned, after, internalErrors: consensus.qc.internalErrors, logs: undefined })
`)

test('a throwing shadow call is swallowed and counted', () => {
    assert.strictEqual(guard.value.returned, null)
    assert.strictEqual(guard.value.internalErrors, 1)
})

test('the guard keeps working after an error', () => {
    assert.strictEqual(guard.value.after, 42)
})

test('the failure is logged, not silent', () => {
    const line = guard.logs.find(l => l[0] === 'error' && l[1].indexOf('QC-INTERNAL-ERROR boom') !== -1)
    assert.ok(line, 'expected a QC-INTERNAL-ERROR log line')
})

console.log('\n--- flag off: zero behaviour change ---')

const off = runChild(offEnv, `
    delete process.env.QC_SHADOW
    const consensus = require(path.join(root, 'src', 'consensus'))
    consensus.qcNoteOwnVote(1, 0, 'block-hash-1')
    consensus.qcObserve(1, 0, 'block-hash-1', 'l1')
    const cmp = consensus.qcCompare(1, 0, 'block-hash-1', 5, 4)
    const guard = consensus.qcGuard('noop', () => { throw new Error('must not run') })
    out({
        enabled: consensus.qc.enabled,
        cmp,
        guard,
        internalErrors: consensus.qc.internalErrors,
        checked: consensus.qc.checked,
        voteStateWritten: require('fs').existsSync(${JSON.stringify(voteStateFile + '.off')})
    })
`)

test('QC_SHADOW unset disables the shadow', () => {
    assert.strictEqual(off.value.enabled, false)
})

test('disabled: no comparison, no counters, no guard execution', () => {
    assert.strictEqual(off.value.cmp, null)
    assert.strictEqual(off.value.guard, null)
    assert.strictEqual(off.value.internalErrors, 0)
    assert.strictEqual(off.value.checked, 0)
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
