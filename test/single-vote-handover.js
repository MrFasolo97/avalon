/* eslint-disable no-magic-numbers */
// == Single-vote default + round handover (M1/M2) ==
// node test/single-vote-handover.js
//
// M1: a higher-round (backup) candidate is the legitimate successor of a silent
// lower-round proposer. It must not be rejected by isBestCandidate's timestamp
// ranking, which always favours the earlier/stale candidate and split the
// precommit quorum.
// M2: COMMIT must follow the node's own PRECOMMIT lock, and among candidates with
// a precommit QC the HIGHEST round wins (a newer view supersedes an older one).

const assert = require('assert')
const consensusQuorum = require('../src/consensusQuorum')

const PRE = consensusQuorum.PRECOMMIT
const COM = consensusQuorum.COMMIT
const ladder = ['l1', 'l2', 'l3', 'l4', 'l5']
const h = 101

if (typeof global.config === 'undefined')
    global.config = {
        b58Alphabet: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        leaders: 5,
        consensusRounds: 2,
        consensusSigVersion: 2,
        blockTime: 3000,
        quorumMin: 3,
        singleVote: true,
        qcEnforce: false,
        forceFinalize: false,
        forceFinalizeFallback: false,
        read: () => global.config
    }
if (typeof global.chain === 'undefined')
    global.chain = {
        getLatestBlock: () => ({ _id: h - 1, hash: 'head' }),
        roundFor: (height, name) => {
            const p = ladder.indexOf(name)
            return p >= 0 ? p : 999
        },
        deriveBlockRank: (block) => ({
            timestamp: block.timestamp,
            ladderPos: ladder.indexOf(block.miner) >= 0 ? ladder.indexOf(block.miner) : 999,
            hash: block.hash || ''
        }),
        compareBlockRank: (a, b) => {
            if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
            if (a.ladderPos !== b.ladderPos) return a.ladderPos - b.ladderPos
            return String(a.hash).localeCompare(String(b.hash))
        },
        validateAndAddBlock: () => {},
        schedule: { shuffle: [] }
    }
if (!global.chain.schedule) global.chain.schedule = { shuffle: [] }
if (typeof global.logr === 'undefined')
    global.logr = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, cons: () => {}, fatal: () => {}, econ: () => {} }
if (typeof global.p2p === 'undefined')
    global.p2p = { broadcast: () => {}, recordBlockFailure: () => {} }

process.env.NODE_OWNER = 'me'

const consensus = require('../src/consensus')
consensus.eligibleLeaders = () => ladder.slice()

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        console.log('  PASS: ' + name)
        passed++
    } catch (e) {
        console.log('  FAIL: ' + name + ' — ' + e.message)
        console.log(e.stack)
        failed++
    }
}

function reset() {
    consensus.ownVoteLedger = consensusQuorum.createLedger({ singleVote: true })
    consensus.peerVoteLedger = consensusQuorum.createLedger({ singleVote: false, trackLocks: false })
    consensus.possBlocks = []
    consensus.heightSeen = {}
    consensus.commitRetry = {}
    consensus.observer = false
}

function pb(hash, miner, timestamp, preVotes) {
    return {
        block: { _id: h, hash, miner, timestamp },
        0: preVotes || [],
        1: []
    }
}

function peerPrecommit(hash, signer, vr) {
    consensus.remoteRoundConfirm({
        d: { r: PRE, b: { hash }, h, vr },
        s: { n: signer }
    })
}

function peerCommit(hash, signer) {
    consensus.remoteRoundConfirm({
        d: { r: COM, b: { hash }, h, vr: 0 },
        s: { n: signer }
    })
}

console.log('=== Single-vote default / round handover (M1, M2) ===\n')

test('singleVote is height-gated in the shipped chain config', () => {
    const realConfig = require('../src/config')
    assert.strictEqual(realConfig.history[0].singleVote, false)
    assert.strictEqual(realConfig.history[13325000].singleVote, undefined,
        'the S/H fork must not override singleVote')
    assert.strictEqual(realConfig.history[14000000].singleVote, true,
        'singleVote must activate at the future height gate')
    assert.strictEqual(realConfig.read(13999999).singleVote, false)
    assert.strictEqual(realConfig.read(14000000).singleVote, true)
    assert.strictEqual(realConfig.history[0].forceFinalizeFallback, false,
        'FF fallback must stay off: no halt recovery by bypassing quorum')
    assert.strictEqual(consensus.singleVoteEnabled, true)
})

test('M1: a higher-round backup is precommitted during leader handover', () => {
    reset()
    const leader = pb('z-leader', 'l1', 1000)
    const backup = pb('a-backup', 'l2', 2000)
    consensus.possBlocks = [leader, backup]
    assert.strictEqual(consensus.lowestCandidateRound(h), 0)
    assert.strictEqual(consensus.castVote(PRE, backup.block), true,
        'the backup must not be rejected for ranking worse than the stale leader')
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'a-backup')
})

test('M1: two candidates in the SAME round still pick one deterministically', () => {
    reset()
    const worse = pb('z-same', 'l1', 2000)
    const better = pb('a-same', 'l1', 1000)
    consensus.possBlocks = [worse, better]
    assert.strictEqual(consensus.lowestCandidateRound(h), 0)
    assert.strictEqual(consensus.castVote(PRE, worse.block), false)
    assert.strictEqual(consensus.castVote(PRE, better.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'a-same')
})

test('M2: COMMIT follows our own precommit lock', () => {
    reset()
    const ours = pb('A', 'l1', 1000)
    const other = pb('B', 'l2', 2000, ['l1', 'l2', 'l3', 'l4'])
    consensus.possBlocks = [ours, other]
    assert.strictEqual(consensus.castVote(PRE, ours.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'A')
    consensus.heightSeen[h] = Date.now() - 60000 // window settled
    assert.strictEqual(consensus.castVote(COM, other.block), false,
        'must not commit a hash we never precommitted')
    assert.deepStrictEqual(
        Array.from(consensusQuorum.signersForHash(consensus.ownVoteLedger, h, COM, 'B', 0)), [])
})

test('M2: the highest round with a precommit QC wins the COMMIT', () => {
    reset()
    const old = pb('old-leader', 'l1', 1000, ['l1', 'l2', 'l3', 'l4'])
    const handover = pb('new-backup', 'l2', 2000, ['l1', 'l2', 'l3', 'l4'])
    consensus.possBlocks = [old, handover]
    const best = consensus.bestCommittableCandidate(h, 4)
    assert.ok(best)
    assert.strictEqual(best.hash, 'new-backup',
        'a later view supersedes the silent earlier proposer')
})

test('M2: once locked, a node commits its own candidate when it is the best one', () => {
    reset()
    const a = pb('A', 'l2', 1000, ['l1', 'l2', 'l3', 'l4'])
    consensus.possBlocks = [a]
    assert.strictEqual(consensus.castVote(PRE, a.block), true)
    assert.strictEqual(consensus.castVote(COM, a.block), true)
})

test('R3b: peer precommits alone never create this node\'s local lock', () => {
    reset()
    const leader = pb('leader-hash', 'l1', 1000)
    consensus.possBlocks = [leader]
    for (const signer of ['l1', 'l2', 'l3', 'l4'])
        peerPrecommit(leader.block.hash, signer, 0)
    for (const signer of ['l1', 'l2', 'l3', 'l4'])
        peerCommit(leader.block.hash, signer)

    // The peer tally counts the votes, but neither its lock nor ours is set.
    assert.strictEqual(consensusQuorum.qcHash(consensus.peerVoteLedger, h, PRE, ladder, 0).hash, 'leader-hash')
    assert.strictEqual(consensusQuorum.lockedOn(consensus.peerVoteLedger, h), null)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), null)
    assert.strictEqual(Array.from(consensusQuorum.signersForHash(
        consensus.ownVoteLedger, h, COM, 'leader-hash', 0)).length, 0)
})

test('R3b: peer precommits for another block never move our lock without a new-block QC', () => {
    reset()
    const leader = pb('leader-hash', 'l1', 1000)
    const backup = pb('backup-hash', 'l2', 2000)
    consensus.possBlocks = [leader, backup]
    assert.strictEqual(consensus.castVote(PRE, leader.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-hash')

    // Two higher-round peer precommits for the backup are below quorum.
    for (const signer of ['l1', 'l2'])
        peerPrecommit(backup.block.hash, signer, 1)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-hash',
        'recording peer votes must not move the local lock')
    assert.strictEqual(consensus.castVote(PRE, backup.block), false,
        'no valid new-block precommit quorum: the node must stay locked')
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-hash')
})

test('R3b: a quorum for the LOCKED block does NOT unlock the node to switch', () => {
    reset()
    const leader = pb('leader-hash', 'l1', 1000)
    const backup = pb('backup-hash', 'l2', 2000)
    consensus.possBlocks = [leader, backup]
    assert.strictEqual(consensus.castVote(PRE, leader.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-hash')

    // This is the flawed 36b8617 case: QCs for the block we are ALREADY locked
    // on, including a higher round, are a reason to STAY — not to switch.
    for (const vr of [0, 1, 2])
        for (const signer of ['l1', 'l2', 'l3', 'l4'])
            peerPrecommit(leader.block.hash, signer, vr)
    assert.strictEqual(consensusQuorum.qcHash(consensus.peerVoteLedger, h, PRE, ladder, 0).hash, 'leader-hash')
    assert.strictEqual(consensus.castVote(PRE, backup.block), false,
        'a QC for the locked block must never justify moving to the backup')
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-hash')
    consensus.heightSeen[h] = Date.now() - 60000
    assert.strictEqual(consensus.castVote(COM, backup.block), false,
        'commit must still follow our own precommit, not a peer-set lock')
})

test('R3b: a valid higher-round precommit QC for the NEW block unlocks and commits', () => {
    reset()
    const leader = pb('leader-hash', 'l1', 1000)
    const backup = pb('backup-hash', 'l2', 2000, ['l1', 'l2', 'l3', 'l4'])
    consensus.possBlocks = [leader, backup]
    assert.strictEqual(consensus.castVote(PRE, leader.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-hash')

    // Peers precommit the NEW candidate in a strictly later view: a valid
    // view-change justification, read from the peer tally only.
    for (const signer of ['l1', 'l2', 'l3', 'l4'])
        peerPrecommit(backup.block.hash, signer, 1)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'leader-hash',
        'peer votes alone still do not move our lock')
    assert.strictEqual(consensus.castVote(PRE, backup.block), true)
    assert.strictEqual(consensusQuorum.lockedOn(consensus.ownVoteLedger, h), 'backup-hash')

    consensus.heightSeen[h] = Date.now() - 60000
    assert.strictEqual(consensus.castVote(COM, backup.block), true,
        'after a justified unlock we may commit the new block')
    assert.ok(consensusQuorum.signersForHash(consensus.ownVoteLedger, h, COM, 'backup-hash', 0).has('me'))
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
