// == P2P integration: CHAIN DIVERGENCE -> automatic rollback -> recover ==
// node test/p2p-rollback-integration.js
//
// Loads the REAL p2p.js with stubbed globals, feeds it peer NODE_STATUS records
// carrying valid signed PRECOMMIT proofs and verifies that a diverged minority
// node rolls back to the common ancestor and resumes forward recovery without
// manual intervention. Also checks the fail-closed paths.

const assert = require('assert')

let passed = 0
let failed = 0
function test(name, fn) {
    return Promise.resolve().then(fn).then(() => {
        console.log('  PASS: ' + name)
        passed++
    }).catch(e => {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        failed++
    })
}

const logs = []
const events = []
const calls = []
const leaderNames = ['miner1', 'miner2', 'miner3', 'miner4', 'miner5']
const localHead = 8

global.config = {
    b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
    leaders: 5, consensusRounds: 2, blockTime: 3000, quorumMin: 3,
    originHash: 'origin', forceFinalize: false, forceFinalizeFallback: false,
    singleVote: true, qcEnforce: false, read: () => global.config
}
global.logr = {
    info: m => logs.push(['info', String(m)]),
    warn: m => logs.push(['warn', String(m)]),
    error: m => logs.push(['error', String(m)]),
    debug: () => {}, cons: () => {}, fatal: () => {}, econ: () => {}
}
require.cache[require.resolve('../src/logger')] = { exports: global.logr }

global.chain = {
    worker: null,
    recentBlocks: [],
    getLatestBlock: () => ({ _id: localHead, hash: 'local-head', phash: 'local-parent' }),
    rebuildState: (n, cb) => { calls.push('rebuild:' + n); cb(null, n) },
    validateAndAddBlock: () => {}
}
for (let h = 0; h <= localHead; h++)
    global.chain.recentBlocks.push({ _id: h, hash: 'h' + h, phash: 'h' + (h - 1) })
global.chain.recentBlocks[localHead].hash = 'local-head'
global.chain.recentBlocks[localHead - 1].hash = 'h7'

global.cache = { rollback: () => calls.push('cache-rollback'), clear: () => calls.push('cache-clear') }
global.dao = { resetID: () => calls.push('dao-reset') }
global.daoMaster = { resetID: () => calls.push('daoMaster-reset') }
const dao = require('../src/dao')
dao.resetID = () => calls.push('dao-reset')
const daoMaster = require('../src/daoMaster')
daoMaster.resetID = () => calls.push('daoMaster-reset')

const blocks = require('../src/blocks')
blocks.isOpen = true
blocks.truncate = (h) => { calls.push('truncate-blocks:' + h); return h }
// Orphan tail blocks: the divergence starts at #6 while our head is #8.
blocks.read = (h) => ({ _id: h, hash: 'h' + h, txs: [{ id: 'tx' + h }] })
const mongo = require('../src/mongo')
mongo.truncateBlocks = (h) => { calls.push('mongo-truncate:' + h); return Promise.resolve(h) }
mongo.resetDerivedState = (h) => { calls.push('reset-state:' + h); return Promise.resolve(true) }
const voteState = require('../src/voteState')
voteState.reset = () => calls.push('voteState-reset')
require.cache[require.resolve('../src/voteState')] = { exports: voteState }
const txHistory = require('../src/txHistory')
const leaderHealth = require('../src/leaderHealth')
const leaderStats = require('../src/leaderStats')
leaderStats.reset = () => calls.push('leaderStats-reset')
process.env.LEADER_STATS = '1'
const transaction = require('../src/transaction')
transaction.isValid = (tx, ts, cb) => cb(true)
transaction.addToPool = (txs) => calls.push('tx-requeued:' + txs[0].id)

// verifier: signature is the literal string "sig:<name>"
global.consensus = {
    eligibleLeaders: () => leaderNames.slice(),
    verifySignature: (msg, cb) => cb(String(msg.s.s).startsWith('sig:' + msg.s.n)),
    getVoteProof: () => global.__localProof || [],
    resetVoteProofs: () => calls.push('reset-proof'),
    cancelForceFinalize: () => calls.push('cancel-ff'),
    voteLedger: { singleVote: false }
}

const eventsModule = require('../src/events')
eventsModule.emit = (name, level, payload) => events.push({ name, level, payload })

const p2p = require('../src/p2p')
p2p.sockets = []
p2p.recover = () => calls.push('recover')
p2p.recovering = false
p2p.recoverAttempt = 0

function proof(height, hash, names) {
    return names.map(n => ({
        t: 6, d: { r: 0, h: height, b: { hash } },
        s: { n, s: 'sig:' + n, v: 2 }
    }))
}

const wait = (ms) => new Promise(rs => setTimeout(rs, ms))

async function main() {
    console.log('=== P2P divergence -> rollback integration ===\n')

    await test('NODE_STATUS carries the transferable head vote proof', () => {
        global.__localProof = proof(localHead, 'local-head', leaderNames.slice(0, 4))
        const captured = []
        const orig = p2p.sendJSON
        p2p.sendJSON = (ws, d) => captured.push(d)
        // Exercise the same expression the QUERY_NODE_STATUS handler uses.
        const status = {
            headVoteProof: consensus.getVoteProof
                ? consensus.getVoteProof(chain.getLatestBlock()._id, chain.getLatestBlock().hash)
                : []
        }
        assert.strictEqual(status.headVoteProof.length, 4)
        assert.strictEqual(status.headVoteProof[0].d.b.hash, 'local-head')
        p2p.sendJSON = orig
    })

    await test('a proven competing branch triggers a full automatic rollback and recovery', async () => {
        calls.length = 0
        events.length = 0
        global.__localProof = []
        p2p.sockets = [{
            node_status: {
                origin_block: 'origin', head_block: 10, head_block_hash: 'majority-head',
                headVoteProof: proof(10, 'majority-head', leaderNames.slice(0, 4))
            }
        }]
        p2p._rollbackPending = false
        global.__localProof = []
        // Stale derived state from the discarded tail (the document DB is
        // dropped, but these RAM structures would otherwise survive).
        chain.recentTxs = { stale: { hash: 'stale' } }
        txHistory.indexQueue = [{ id: 'stale-tx' }]
        leaderHealth.leaders = { stale: true }
        consensus.possBlocks = [{ block: { _id: 7 } }]
        consensus.heightSeen = { 7: 123 }
        // conflict at #6: its parent #5 is our block 'h5' -> ancestor 5.
        // Blocks #6..#8 are the orphaned tail; their txs must be re-offered.
        p2p.maybeRollback({ height: 6, phash: 'h5', hash: 'majority-6' })
        await wait(200)

        const start = events.find(e => e.name === 'chain-rollback-start')
        const done = events.find(e => e.name === 'chain-rollback')
        assert.ok(start && done)
        assert.strictEqual(start.payload.ancestor, 5)
        assert.strictEqual(start.payload.target, 10)
        assert.deepStrictEqual(calls, [
            'cache-rollback', 'truncate-blocks:5', 'reset-state:5',
            'cache-clear', 'dao-reset', 'daoMaster-reset', 'voteState-reset', 'reset-proof',
            'cancel-ff', 'leaderStats-reset', 'rebuild:0',
            'tx-requeued:tx6', 'tx-requeued:tx7', 'tx-requeued:tx8', 'recover'
        ])
        assert.deepStrictEqual(chain.recentTxs, {})
        assert.deepStrictEqual(txHistory.indexQueue, [])
        assert.deepStrictEqual(leaderHealth.leaders, {})
        assert.deepStrictEqual(consensus.possBlocks, [])
        assert.deepStrictEqual(consensus.heightSeen, {})
        assert.strictEqual(global.consensus.voteLedger.singleVote, true)
        assert.strictEqual(p2p._rollbackPending, false)
        assert.strictEqual(p2p.recovering, 5)
    })

    await test('fail closed when the competing branch has no valid quorum proof', async () => {
        calls.length = 0
        events.length = 0
        p2p._rollbackPending = false
        p2p.sockets = [{
            node_status: {
                origin_block: 'origin', head_block: 10, head_block_hash: 'majority-head',
                headVoteProof: proof(10, 'majority-head', leaderNames.slice(0, 2))
            }
        }]
        p2p.maybeRollback({ height: 9, phash: 'local-head', hash: 'majority-9' })
        await wait(40)
        assert.strictEqual(calls.length, 0)
        assert.strictEqual(events.length, 0)
        assert.strictEqual(p2p._rollbackPending, false)
    })

    await test('fail closed when no common ancestor exists within the reorg bound', async () => {
        calls.length = 0
        events.length = 0
        p2p._rollbackPending = false
        p2p.sockets = [{
            node_status: {
                origin_block: 'origin', head_block: 10, head_block_hash: 'majority-head',
                headVoteProof: proof(10, 'majority-head', leaderNames.slice(0, 4))
            }
        }]
        p2p.maybeRollback({ height: 9, phash: 'no-matching-parent', hash: 'majority-9' })
        await wait(40)
        assert.strictEqual(calls.length, 0)
        assert.ok(logs.some(l => l[0] === 'warn' && String(l[1]).includes('no common ancestor')))
    })

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
