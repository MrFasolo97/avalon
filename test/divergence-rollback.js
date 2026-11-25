// == F8: CHAIN DIVERGENCE detection and automatic rollback ==
// node test/divergence-rollback.js
//
// A minority fork must recover without an operator: verify the competing
// branch's signed vote proof, find the common ancestor, truncate the local
// tail, reset derived state, rebuild deterministically and resume forward
// recovery. Every destructive step must fail closed.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        maxTxPerBlock: 200, jsonMaxBytes: 60000, quorumMin: 3
    }
if (typeof global.logr === 'undefined')
    global.logr = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {} }
require.cache[require.resolve('../src/logger')] = { exports: global.logr }

const voteProof = require('../src/voteProof')
const divergence = require('../src/divergence')

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

// deterministic fake verifier: signatures are the literal string "sig:<name>"
const verify = (msg, cb) => cb(String(msg.s.s).startsWith('sig:' + msg.s.n))

function proof(height, hash, names) {
    return {
        height, hash,
        votes: names.map(n => ({
            t: 6, d: { r: 1, h: height, b: { hash } }, // 1 = COMMIT (finality)
            s: { n, s: 'sig:' + n, v: 2 }
        }))
    }
}

async function main() {
    console.log('=== Divergence detection / automatic rollback ===\n')

    await test('vote proof: quorum of distinct eligible COMMITs is valid', () => {
        const p = proof(7, 'aaa', ['miner1', 'miner2', 'miner3', 'miner4'])
        const r = voteProof.verifyProof(p, {
            verifySignature: verify,
            eligible: ['miner1', 'miner2', 'miner3', 'miner4', 'miner5'],
            quorum: 4
        })
        assert.strictEqual(r.valid, true)
        assert.strictEqual(r.count, 4)
    })

    await test('vote proof: invalid signature, duplicate signer and wrong hash are rejected', () => {
        const good = proof(7, 'aaa', ['miner1', 'miner2', 'miner3', 'miner4'])
        const eligible = good.votes.map(v => v.s.n)
        const bad = JSON.parse(JSON.stringify(good))
        bad.votes[0].s.s = 'sig:someone-else'
        assert.strictEqual(voteProof.verifyProof(bad, { verifySignature: verify, eligible, quorum: 4 }).valid, false)

        const dup = JSON.parse(JSON.stringify(good))
        dup.votes[1].s.n = 'miner1'
        dup.votes[1].s.s = 'sig:miner1'
        assert.strictEqual(voteProof.verifyProof(dup, { verifySignature: verify, eligible, quorum: 4 }).valid, false)

        const wrongHash = JSON.parse(JSON.stringify(good))
        wrongHash.votes[2].d.b.hash = 'bbb'
        assert.strictEqual(voteProof.verifyProof(wrongHash, { verifySignature: verify, eligible, quorum: 4 }).valid, false)

        const short = { height: 7, hash: 'aaa', votes: good.votes.slice(0, 2) }
        assert.strictEqual(voteProof.verifyProof(short, { verifySignature: verify, eligible, quorum: 4 }).valid, false)
    })

    await test('vote proof: PRECOMMITs are never accepted as finality evidence', () => {
        const p = proof(7, 'aaa', ['miner1', 'miner2', 'miner3', 'miner4'])
        p.votes.forEach(v => { v.d.r = 0 })
        assert.strictEqual(voteProof.verifyProof(p, {
            verifySignature: verify,
            eligible: ['miner1', 'miner2', 'miner3', 'miner4', 'miner5'],
            quorum: 4
        }).valid, false)
    })

    await test('fork choice: a locally finalized head is never replaced by a peer proof', () => {
        const eligible = ['miner1', 'miner2', 'miner3', 'miner4', 'miner5']
        assert.strictEqual(voteProof.stronger(
            { valid: true, height: 99, hash: 'peer', count: 5 },
            { valid: true, height: 10, hash: 'local', count: 4 }
        ), false)
        assert.strictEqual(voteProof.stronger(
            { valid: true, height: 10, hash: 'peer', count: 5 },
            { valid: true, height: 10, hash: 'local', count: 4 }
        ), false)
        assert.strictEqual(voteProof.stronger(
            { valid: true, height: 13, hash: 'peer', count: 4 },
            { valid: false, height: 10, hash: 'local', count: 0 }
        ), true)
        const d = divergence.evaluate({
            quorum: 4, eligible, verifySignature: verify,
            local: { height: 10, hash: 'local', proof: proof(10, 'local', eligible).votes },
            peers: [{ height: 99, hash: 'peer', proof: proof(99, 'peer', eligible).votes }]
        })
        assert.strictEqual(d, null)
    })

    await test('detection: eligible set and quorum are resolved at each proof height', () => {
        const heights = []
        const localEligible = ['l1', 'l2', 'l3', 'l4', 'l5']
        const peerEligible = ['p1', 'p2', 'p3', 'p4', 'p5']
        const d = divergence.evaluate({
            verifySignature: verify,
            eligibleAt: (h) => { heights.push('e:' + h); return h < 12 ? localEligible : peerEligible },
            quorumAt: (h) => { heights.push('q:' + h); return 4 },
            local: { height: 10, hash: 'local', proof: [] },
            peers: [{ height: 13, hash: 'majority', proof: proof(13, 'majority', peerEligible.slice(0, 4)).votes }]
        })
        assert.ok(d && d.shouldRollback)
        assert.deepStrictEqual(heights.sort(), ['e:10', 'e:13', 'q:10', 'q:13'])
        // The same votes signed by the local-height set cannot prove the peer
        // height when the peer height has a different eligible set.
        const wrong = divergence.evaluate({
            verifySignature: verify,
            eligibleAt: (h) => h < 12 ? localEligible : peerEligible,
            quorumAt: () => 4,
            local: { height: 10, hash: 'local', proof: [] },
            peers: [{ height: 13, hash: 'majority', proof: proof(13, 'majority', localEligible.slice(0, 4)).votes }]
        })
        assert.strictEqual(wrong, null)
    })

    await test('detection: proven competing chain triggers rollback, unproven does not', () => {
        const eligible = ['miner1', 'miner2', 'miner3', 'miner4', 'miner5']
        const input = {
            quorum: 4, eligible, verifySignature: verify,
            local: { height: 10, hash: 'local', proof: [] },
            peers: [{ height: 13, hash: 'majority', proof: proof(13, 'majority', eligible.slice(0, 4)).votes }]
        }
        const d = divergence.evaluate(input)
        assert.ok(d && d.shouldRollback)
        assert.strictEqual(d.height, 13)
        assert.strictEqual(d.hash, 'majority')

        const bad = Object.assign({}, input, {
            peers: [{ height: 13, hash: 'majority', proof: proof(13, 'majority', eligible.slice(0, 2)).votes }]
        })
        assert.strictEqual(divergence.evaluate(bad), null)
    })

    await test('detection: a locally proven chain is NOT abandoned for a weaker peer', () => {
        const eligible = ['miner1', 'miner2', 'miner3', 'miner4', 'miner5']
        const d = divergence.evaluate({
            quorum: 4, eligible, verifySignature: verify,
            local: { height: 10, hash: 'local', proof: proof(10, 'local', eligible).votes },
            peers: [{ height: 10, hash: 'peer', proof: proof(10, 'peer', eligible.slice(0, 4)).votes }]
        })
        assert.strictEqual(d, null)
    })

    await test('ancestor: walks back to the matching parent and fails closed when unbounded', () => {
        const hashes = { 0: 'g', 1: 'a', 2: 'b', 3: 'c', 4: 'local' }
        const a = divergence.findAncestor({
            height: 5, phash: 'x', localHashAt: h => hashes[h] || null, maxReorg: 4
        })
        assert.strictEqual(a, null)
        hashes[3] = 'x'
        assert.strictEqual(divergence.findAncestor({
            height: 5, phash: 'x', localHashAt: h => hashes[h] || null, maxReorg: 4
        }), 3)
    })

    await test('ancestor: identical or unverifiable local block at the contested height is never a reorg', () => {
        const hashes = { 0: 'g', 1: 'a', 2: 'b', 3: 'c', 4: 'local' }
        // Same hash as our local #4: a serialized duplicate delivery, not a fork.
        assert.strictEqual(divergence.findAncestor({
            height: 4, hash: 'local', phash: 'c', localHashAt: h => hashes[h] || null
        }), null)
        // No local block at the contested height: fail closed.
        assert.strictEqual(divergence.findAncestor({
            height: 5, hash: 'peer-5', phash: 'local', localHashAt: h => hashes[h] || null
        }), null)
        // A genuinely different block at the contested height still finds the ancestor.
        assert.strictEqual(divergence.findAncestor({
            height: 4, hash: 'peer-4', phash: 'c', localHashAt: h => hashes[h] || null
        }), 3)
    })

    await test('ancestor: reorg bound comes from chain config, not an env var', () => {
        const previous = global.config.maxReorgDepth
        const hashes = { 0: 'g', 1: 'a', 2: 'b', 3: 'c', 4: 'local' }
        delete process.env.MAX_REORG_DEPTH
        global.config.maxReorgDepth = 2
        try {
            assert.strictEqual(divergence.findAncestor({
                height: 5, phash: 'x', localHashAt: h => hashes[h] || null
            }), null)
            global.config.maxReorgDepth = 3
            assert.strictEqual(divergence.findAncestor({
                height: 5, phash: 'x', localHashAt: h => hashes[h] || null
            }), null)
            hashes[3] = 'x'
            assert.strictEqual(divergence.findAncestor({
                height: 5, phash: 'x', localHashAt: h => hashes[h] || null
            }), 3)
        } finally {
            if (previous === undefined) delete global.config.maxReorgDepth
            else global.config.maxReorgDepth = previous
        }
    })

    await test('rollback: rebuilds and swaps state before truncating blocks, emits events', async () => {
        const calls = []
        const events = []
        const d = {
            shouldRollback: true, fromHeight: 12, ancestor: 9, height: 13,
            hash: 'majority', signers: ['miner1', 'miner2', 'miner3', 'miner4']
        }
        await divergence.rollback(d, {
            logr: global.logr,
            events: { emit: (n) => events.push(n) },
            preflightSnapshot: (h) => { calls.push('preflight:' + h); return true },
            markRollback: () => calls.push('mark'),
            pause: () => calls.push('pause'),
            resetState: (h) => calls.push('state:' + h),
            resetRuntime: (h) => calls.push('runtime:' + h),
            rebuildState: (h) => { calls.push('rebuild:' + h); return Promise.resolve(h) },
            finalizeState: (h) => calls.push('finalize:' + h),
            markSwapped: () => calls.push('markSwapped'),
            truncateBlocks: (h) => { calls.push('truncate:' + h); return h },
            resume: (h) => calls.push('resume:' + h),
            clearRollbackMarker: () => calls.push('clearMarker')
        })
        assert.deepStrictEqual(calls, ['preflight:9', 'mark', 'pause', 'state:9', 'runtime:9', 'rebuild:9', 'finalize:9', 'markSwapped', 'truncate:9', 'resume:9', 'clearMarker'])
        assert.deepStrictEqual(events, ['chain-rollback-start', 'chain-rollback'])
    })

    await test('rollback: refuses an unproven decision without touching persistence', async () => {
        let touched = false
        await assert.rejects(() => divergence.rollback({ shouldRollback: true, height: 10 },
            { truncateBlocks: () => { touched = true } }))
        assert.strictEqual(touched, false)
    })

    await test('rollback: refuses to truncate when no usable state snapshot exists', async () => {
        const calls = []
        await assert.rejects(() => divergence.rollback({
            shouldRollback: true, fromHeight: 12, ancestor: 9, height: 13, hash: 'majority'
        }, {
            logr: global.logr, events: { emit: () => {} },
            hasSnapshot: () => Promise.resolve(false),
            pause: () => calls.push('pause'),
            truncateBlocks: () => calls.push('truncate'),
            resetState: () => calls.push('state'),
            rebuildState: () => calls.push('rebuild')
        }), /no usable state snapshot/)
        assert.deepStrictEqual(calls, [])
    })

    await test('rollback: mid-failure after swap leaves recovery marker and does not clear it', async () => {
        const calls = []
        let markerPhase = null
        await assert.rejects(() => divergence.rollback({
            shouldRollback: true, fromHeight: 5, ancestor: 3, height: 6, hash: 'x'
        }, {
            logr: global.logr, events: { emit: () => {} },
            preflightSnapshot: () => true,
            markRollback: () => { markerPhase = 'started'; calls.push('mark') },
            pause: () => calls.push('pause'),
            resetState: () => calls.push('state'),
            resetRuntime: () => calls.push('runtime'),
            rebuildState: () => calls.push('rebuild'),
            finalizeState: () => calls.push('finalize'),
            markSwapped: () => { markerPhase = 'swapped'; calls.push('markSwapped') },
            truncateBlocks: () => { throw new Error('disk failure') },
            resume: () => calls.push('resume'),
            clearRollbackMarker: () => { markerPhase = null; calls.push('clear') }
        }), /disk failure/)
        assert.deepStrictEqual(calls, ['mark', 'pause', 'state', 'runtime', 'rebuild', 'finalize', 'markSwapped'])
        assert.strictEqual(markerPhase, 'swapped')
    })

    await test('rollback: failure before swap keeps live blocks untouched', async () => {
        const calls = []
        let markerPhase = null
        await assert.rejects(() => divergence.rollback({
            shouldRollback: true, fromHeight: 5, ancestor: 3, height: 6, hash: 'x'
        }, {
            logr: global.logr, events: { emit: () => {} },
            preflightSnapshot: () => true,
            markRollback: () => { markerPhase = 'started'; calls.push('mark') },
            pause: () => calls.push('pause'),
            resetState: () => calls.push('state'),
            resetRuntime: () => calls.push('runtime'),
            rebuildState: () => { throw new Error('rebuild failed') },
            finalizeState: () => calls.push('finalize'),
            truncateBlocks: () => calls.push('truncate'),
            clearRollbackMarker: () => { markerPhase = null; calls.push('clear') }
        }), /rebuild failed/)
        assert.deepStrictEqual(calls, ['mark', 'pause', 'state', 'runtime'])
        assert.strictEqual(markerPhase, 'started')
    })

    await test('BSON store truncation keeps the ancestor readable and drops the fork', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-reorg-'))
        const prevDir = process.env.BLOCKS_DIR
        process.env.BLOCKS_DIR = tmp
        global.chain = {
            getGenesisBlock: () => ({ _id: 0, hash: 'g', txs: [], dist: 0, burn: 0 })
        }
        global.eco = { loadHistory: () => {} }
        delete require.cache[require.resolve('../src/blocks')]
        const blocks = require('../src/blocks')
        blocks.touch()
        blocks.fd = fs.openSync(path.join(tmp, 'blocks.bson'), 'a+')
        blocks.fdIndex = fs.openSync(path.join(tmp, 'blocks.index'), 'a+')
        blocks.bsonSize = 0n
        blocks.height = -1
        blocks.isOpen = true
        for (let h = 0; h <= 5; h++)
            blocks.appendBlock({ _id: h, hash: 'h' + h, txs: [], dist: 0, burn: 0 })

        blocks.truncate(3)
        assert.strictEqual(blocks.height, 3)
        assert.strictEqual(fs.statSync(path.join(tmp, 'blocks.index')).size, 4 * 8)
        assert.strictEqual(blocks.read(3).hash, 'h3')
        assert.throws(() => blocks.read(4), /Block not found/)
        blocks.close()
        fs.rmSync(tmp, { recursive: true, force: true })
        if (prevDir === undefined) delete process.env.BLOCKS_DIR
        else process.env.BLOCKS_DIR = prevDir
    })

    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
    process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
