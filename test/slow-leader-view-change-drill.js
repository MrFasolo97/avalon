/* eslint-disable no-magic-numbers */
// == R3b drill: slow leader / view-change across the 14,000,000 flag day ==
// node test/slow-leader-view-change-drill.js
//
// Headless drill of the REAL consensus module (no stubbed castVote, rebuildState,
// recordVote or tryNextStep). The scheduled leader stalls, a backup proposes in a
// later view, peer precommits form, and the node must unlock and finalize the
// backup through the normal COMMIT quorum — with NO force-finalize and NO
// halt-breaker. Run at the real config gate (13999999 off / 14000000+ on).

const assert = require('assert')

const PRE = 0
const COM = 1
// Round order: the stalled leader is round 0, the backup round 1.
const ladder = ['leader1', 'backup1', 'me', 'peer3', 'peer4']
const eligible = ladder.slice()
const HEAD_BASE = 1600000000000

let head = null
const finalized = []
const fatalMessages = []
const errorMessages = []

global.logr = {
    info() {}, warn() {}, debug() {}, cons() {}, econ() {}, trace() {},
    error(...args) { errorMessages.push(args.join(' ')) },
    fatal(...args) { fatalMessages.push(args.join(' ')) }
}
const realConfig = require('../src/config')
// Production merges config.read(height) over the global config object; mirror
// that here while keeping the REAL height-gated read() for the flag day.
global.config = Object.assign({}, realConfig.read(14000000), {
    read: realConfig.read,
    history: realConfig.history
})
global.chain = {
    getLatestBlock: () => head,
    roundFor: (height, name) => {
        const i = ladder.indexOf(name)
        return i >= 0 ? i : 999
    },
    deriveBlockRank: block => ({
        timestamp: block.timestamp,
        ladderPos: ladder.indexOf(block.miner) >= 0 ? ladder.indexOf(block.miner) : 999,
        hash: block.hash || ''
    }),
    compareBlockRank: (a, b) => {
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
        if (a.ladderPos !== b.ladderPos) return a.ladderPos - b.ladderPos
        return String(a.hash).localeCompare(String(b.hash))
    },
    validateAndAddBlock: (block, revalidate, cb) => {
        finalized.push(block)
        head = block
        cb(null)
    },
    schedule: { shuffle: [] }
}
global.p2p = { broadcast() {}, recordBlockFailure() {} }
process.env.NODE_OWNER = 'me'

const consensusQuorum = require('../src/consensusQuorum')
const consensus = require('../src/consensus')

let passed = 0
let failed = 0
function test(name, fn) {
    try {
        fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' \u2014 ' + e.message)
        console.log(e.stack)
        failed++
    }
}

function candidate(hash, miner, round, precommits) {
    return {
        block: { _id: head._id + 1, hash, miner, timestamp: HEAD_BASE + round * 3000 },
        [PRE]: precommits || [],
        [COM]: []
    }
}

function remoteVote(phase, hash, signer, vr) {
    consensus.remoteRoundConfirm({
        d: { r: phase, b: { hash }, h: head._id + 1, vr },
        s: { n: signer }
    })
}

function setupDrill(height) {
    head = { _id: height - 1, hash: 'head-' + (height - 1), timestamp: HEAD_BASE - 3000 }
    finalized.length = 0
    fatalMessages.length = 0
    errorMessages.length = 0
    consensus.ownVoteLedger = consensusQuorum.createLedger({ singleVote: true })
    consensus.peerVoteLedger = consensusQuorum.createLedger({ singleVote: false, trackLocks: false })
    consensus.possBlocks = []
    consensus.heightSeen = {}
    consensus.commitRetry = {}
    consensus.finalizing = false
    consensus.observer = false
    consensus.tryNextStepBusy = false
    consensus.tryNextStepScheduled = false
    consensus._localFinalizedHeight = null
    consensus._localFinalizedHash = null
    consensus.eligibleLeaders = () => eligible.slice()
    consensus.isActive = () => true
    // Headless harness: broadcasts need signing keys; the vote tallies are fed
    // through remoteRoundConfirm instead. round()/endRound() are NOT the safety
    // path under test — castVote, recordVote and tryNextStep are all real.
    consensus.round = () => {}
    consensus.endRound = () => {}
    consensus.scheduleForceFinalize = () => { throw new Error('force-finalize was scheduled') }
    consensus.runHaltBreaker = () => { throw new Error('halt-breaker was triggered') }
    consensus.cancelForceFinalize = () => {}
}

// Drive one height: leader stalls at round 0, backup proposes at round 1.
function slowLeaderHeight(height) {
    setupDrill(height)
    const h = head._id + 1
    const leader = candidate('leader-block', 'leader1', 0)
    const backup = candidate('backup-block', 'backup1', 1)
    consensus.possBlocks = [leader, backup]

    // Our own precommit locks the slow leader's block.
    assert.strictEqual(consensus.singleVoteAt(h), true, 'single vote must be active at ' + h)
    assert.strictEqual(consensus.castVote(PRE, leader.block), true)

    // The flawed rule: a QC for the block we are locked on must not let us
    // switch to the backup, even at a later round.
    for (const vr of [0, 1])
        for (const signer of ['leader1', 'backup1', 'peer3', 'peer4'])
            remoteVote(PRE, leader.block.hash, signer, vr)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-block')
    assert.strictEqual(consensus.castVote(PRE, backup.block), false,
        'a quorum for the locked block must not justify switching')

    // Valid view change: a NEW-block precommit quorum in a later round.
    for (const signer of ['leader1', 'backup1', 'peer3', 'peer4'])
        remoteVote(PRE, backup.block.hash, signer, 1)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-block',
        'peer votes alone must not move the local lock')
    assert.strictEqual(consensus.castVote(PRE, backup.block), true,
        'the new-block QC must unlock our precommit')
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'backup-block')

    // Our precommit is broadcast by endRound in production; feed the tally here.
    backup[PRE].push(process.env.NODE_OWNER)
    consensus.heightSeen[h] = Date.now() - (global.config.leaders + 1) * global.config.blockTime - 5000
    assert.strictEqual(consensus.castVote(COM, backup.block), true,
        'we must commit exactly the block we precommitted')

    // Peer COMMITs complete the quorum; remoteRoundConfirm itself calls the
    // REAL tryNextStep, which applies the winner. No FF/halt-breaker involved.
    for (const signer of ['leader1', 'backup1', 'peer3', 'peer4'])
        remoteVote(COM, backup.block.hash, signer, 1)
    consensus.tryNextStep()
    assert.deepStrictEqual(finalized.map(b => b.hash), ['backup-block'],
        'only the view-change winner may be finalized')
    assert.strictEqual(head.hash, 'backup-block')
    assert.strictEqual(consensus.finalizing, false)
    assert.strictEqual(fatalMessages.length, 0, 'no fatal fallback: ' + fatalMessages.join(' | '))
    assert.strictEqual(errorMessages.length, 0, 'no recovery errors: ' + errorMessages.join(' | '))
}

console.log('=== R3b drill: slow leader / view change at the 14M gate ===\n')

test('the real config flips singleVote at exactly 14,000,000', () => {
    assert.strictEqual(global.config.read(13999999).singleVote, false)
    assert.strictEqual(global.config.read(14000000).singleVote, true)
    assert.strictEqual(global.config.read(14000001).singleVote, true)
    assert.strictEqual(consensus.singleVoteAt(13999999), false)
    assert.strictEqual(consensus.singleVoteAt(14000000), true)
})

for (const h of [14000000, 14000001])
    test('slow leader at #' + h + ' finalizes the backup via view-change, no FF/halt-breaker', () => {
        slowLeaderHeight(h)
    })

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED')
    + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
