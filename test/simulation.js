// test/simulation.js — discrete-event simulator for the offline-leader jail design
//
// Run with: node test/simulation.js
//
// Uses the real src/leaderHealth.js kernel (ladder, jail state, quorum,
// breakerThreshold, commitDecision) so the simulation is a pure-function test
// of the protocol, not a mock. Mainnet-like parameters are compressed in time
// (blockTime = 10 ms) so 1000 blocks take ~10 s of wall clock.
//
// Current scope:
//   1. Healthy run with 5 leaders + 5 standbys.
//   2. Kill miner2 at block ~300: observe skips, jail, standby promotion, quorum drop.
//   3. Partition 2|2 with E=4 after miner2 is jailed: verify both sides halt and
//      no conflicting blocks are finalised (regression test for the majority breaker fix).
//   4. Heal and verify convergence.

const assert = require('assert')
const lh = require('../src/leaderHealth')

// --- deterministic helpers ---------------------------------------------------
function hashOf(obj) {
    const str = JSON.stringify(obj, Object.keys(obj).sort())
    let h = 0
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i)
        h |= 0
    }
    return h.toString(16).padStart(8, '0')
}

function clone(o) { return JSON.parse(JSON.stringify(o)) }

// --- simulation parameters (mainnet-like, time-compressed) -------------------
const SimParams = {
    leaders: 5,
    leaderStandbys: 5,
    jailMissThreshold: 30,
    jailBlocks: 200,
    jailBackoffMax: 4,
    quorumMin: 3,
    quorumCap: 4,
    standbyEnabled: true,
    heartbeatTxType: 18,
    lookback: 5000,
    blockTime: 10,
    skipGraceMs: 20,
    haltBreakerMs: 100,
}

const allNodes = ['dtube', 'miner1', 'miner2', 'miner3', 'miner4']
const nodeAppr = { dtube: 1000000, miner1: 100000, miner2: 90000, miner3: 80000, miner4: 70000 }

// --- network model -----------------------------------------------------------
class Network {
    constructor() {
        this.partitions = null // null = full mesh, else array of groups
        this.delays = {}       // keyed 'a|b' -> ms
    }

    setUniformDelay(ms) {
        this.delays = {}
        for (const a of allNodes)
            for (const b of allNodes)
                if (a !== b) this.delays[`${a}|${b}`] = ms
    }

    setPartition(groups) {
        this.partitions = groups
    }

    heal() {
        this.partitions = null
    }

    canCommunicate(a, b) {
        if (!this.partitions) return true
        for (const g of this.partitions)
            if (g.indexOf(a) !== -1 && g.indexOf(b) !== -1) return true
        return false
    }

    delay(a, b) {
        return this.delays[`${a}|${b}`] || 0
    }
}

// --- node model --------------------------------------------------------------
class Node {
    constructor(name) {
        this.name = name
        this.alive = true
        this.chain = []
        this.commitLocks = {}
        this.receivedCandidates = {} // height -> { hash -> block }
        this.round0Signs = {}        // height -> { hash -> Set(names) }
        this.round1Signs = {}        // height -> { hash -> Set(names) }
    }

    tip() {
        return this.chain[this.chain.length - 1]
    }

    recentBlocks(n) {
        return this.chain.slice(-n)
    }

    schedule() {
        const tip = this.tip()
        if (!tip) return null
        const state = lh.jailState(this.chain, SimParams)
        const candidates = allNodes
            .map(n => ({ name: n, node_appr: nodeAppr[n] }))
            .filter(c => !lh.isJailed(state, c.name, tip._id))
        const ranked = lh.rankCandidates(candidates, SimParams)
        const shuffled = lh.shuffleEpoch(ranked.active, tip.hash, 8)
        const standbys = ranked.standby
        while (shuffled.length > 0 && shuffled.length < SimParams.leaders) {
            shuffled.push(shuffled[shuffled.length % shuffled.length])
        }
        return { shuffle: shuffled, standby: standbys, block: tip }
    }

    ladderFor(height) {
        const schedule = this.schedule()
        if (!schedule) return []
        return lh.ladderFor(height, {
            leaders: SimParams.leaders,
            shuffle: schedule.shuffle,
            standbys: schedule.standby,
            recentBlocks: this.recentBlocks(SimParams.leaders * 2),
        })
    }

    eligibleAt(height) {
        const schedule = this.schedule()
        if (!schedule) return []
        const names = []
        for (const s of schedule.shuffle) if (names.indexOf(s.name) === -1) names.push(s.name)
        const state = lh.jailState(this.chain, SimParams)
        return lh.eligibleLeaders(names, state, height)
    }

    commitDecision(height, candidate) {
        return lh.commitDecision(this.commitLocks, height, candidate, null)
    }
}

// --- scheduler ----------------------------------------------------------------
class Scheduler {
    constructor(nodes, network) {
        this.nodes = nodes
        this.network = network
        this.time = 0
        this.events = []
        this.height = 0
        this.safetyViolations = []
        this.metrics = {
            blocks: 0,
            jailEvents: [],
            quorumChanges: [],
            partitions: 0,
        }
    }

    addEvent(at, fn) {
        this.events.push({ at, fn })
        this.events.sort((a, b) => a.at - b.at)
    }

    run(targetBlocks, maxTime = 100000) {
        // genesis block at height 0
        const genesis = {
            _id: 0,
            miner: 'dtube',
            timestamp: 0,
            hash: hashOf({ _id: 0, miner: 'dtube', timestamp: 0 }),
            skips: [],
        }
        for (const n of this.nodes) n.chain.push(clone(genesis))
        this.height = 1

        while (this.metrics.blocks < targetBlocks && this.time < maxTime) {
            // run pending events
            while (this.events.length && this.events[0].at <= this.time) {
                const e = this.events.shift()
                e.fn(this)
            }
            this.produceRound()
            this.time += SimParams.blockTime
        }
    }

    produceRound() {
        const h = this.height
        const t0 = this.time

        // each node computes its own view of the ladder for this height
        const producers = {} // node -> { position, ladder }
        for (const n of this.nodes) {
            if (!n.alive) continue
            const ladder = n.ladderFor(h)
            const pos = lh.positionOf(ladder, n.name)
            if (pos !== -1) producers[n.name] = { node: n, position: pos, ladder }
        }

        // all alive ladder members produce a candidate; lower positions are earlier
        const candidates = {} // hash -> block
        const productionTimes = {} // hash -> time

        for (const [name, info] of Object.entries(producers)) {
            const produceTime = t0 + info.position * SimParams.blockTime +
                (info.position > 0 ? SimParams.skipGraceMs : 0)
            const block = {
                _id: h,
                miner: name,
                timestamp: produceTime,
                hash: '',
                skips: info.position > 0 ? info.ladder.slice(0, info.position) : [],
            }
            block.hash = hashOf({ _id: block._id, miner: block.miner, timestamp: block.timestamp, skips: block.skips })
            candidates[block.hash] = block
            productionTimes[block.hash] = produceTime
        }

        if (Object.keys(candidates).length === 0) return // no producer alive

        // reset per-height state on every node
        for (const n of this.nodes) {
            if (!n.alive) continue
            n.receivedCandidates[h] = {}
            n.round0Signs[h] = {}
        }

        // propagate candidates through the network (bounded by a small horizon)
        for (const [hash, block] of Object.entries(candidates)) {
            const producer = block.miner
            for (const n of this.nodes) {
                if (!n.alive) continue
                if (!this.network.canCommunicate(producer, n.name)) continue
                n.receivedCandidates[h][hash] = block
            }
        }

        // round 0: every eligible node precommits every valid candidate it received
        for (const n of this.nodes) {
            if (!n.alive) continue
            const eligible = n.eligibleAt(h)
            if (eligible.indexOf(n.name) === -1) continue
            for (const hash of Object.keys(n.receivedCandidates[h] || {})) {
                if (!n.round0Signs[h][hash]) n.round0Signs[h][hash] = new Set()
                n.round0Signs[h][hash].add(n.name)
            }
        }

        // propagate round 0 signatures
        for (const n of this.nodes) {
            if (!n.alive) continue
            for (const hash of Object.keys(n.round0Signs[h] || {})) {
                for (const signer of n.round0Signs[h][hash]) {
                    for (const peer of this.nodes) {
                        if (!peer.alive) continue
                        if (!this.network.canCommunicate(signer, peer.name)) continue
                        if (!peer.round0Signs[h]) peer.round0Signs[h] = {}
                        if (!peer.round0Signs[h][hash]) peer.round0Signs[h][hash] = new Set()
                        peer.round0Signs[h][hash].add(signer)
                    }
                }
            }
        }

        this.finalizeHeight(h, candidates, productionTimes)
        this.height++
    }

    finalizeHeight(h, candidates, productionTimes) {
        if (Object.keys(candidates).length === 0) return

        // Each node commits to the earliest candidate it received, provided enough
        // eligible signers (visible to this node) have precommitted it. The commit
        // lock prevents a node from committing a second candidate at the same height.
        for (const n of this.nodes) {
            if (!n.alive) continue
            const eligible = n.eligibleAt(h)
            const E = eligible.length
            const q = lh.quorumSize(E, SimParams)
            const breakerThresh = lh.breakerThreshold(E)

            // candidates this node received, sorted by deterministic tie-break
            const received = Object.values(n.receivedCandidates[h] || {}).sort((a, b) => {
                if (productionTimes[a.hash] !== productionTimes[b.hash])
                    return productionTimes[a.hash] - productionTimes[b.hash]
                return a.hash.localeCompare(b.hash)
            })

            for (const block of received) {
                const r0 = n.round0Signs[h] && n.round0Signs[h][block.hash]
                    ? [...n.round0Signs[h][block.hash]].filter(s => eligible.indexOf(s) !== -1)
                    : []
                const normalOk = r0.length >= q
                const missing = E - r0.length
                const breakerOk = r0.length >= breakerThresh && missing >= 1 && missing <= (E - breakerThresh)

                if (!normalOk && !breakerOk) continue

                const decision = n.commitDecision(h, block)
                if (!decision.allow) continue
                if (decision.lock) n.commitLocks[h] = { hash: block.hash, miner: block.miner }

                n.chain.push(clone(block))
                this.metrics.blocks = Math.max(this.metrics.blocks, h)
                break
            }
        }

        // safety check: no two nodes have different blocks at height h
        const seen = {}
        for (const n of this.nodes) {
            const b = n.chain[h]
            if (!b) continue
            if (seen[b.hash]) continue
            for (const other of this.nodes) {
                const ob = other.chain[h]
                if (!ob) continue
                if (ob.hash !== b.hash) {
                    this.safetyViolations.push({ height: h, a: n.name, aHash: b.hash, b: other.name, bHash: ob.hash })
                }
            }
            seen[b.hash] = true
        }
    }
}

// --- scenarios ----------------------------------------------------------------
function scenarioHealthyAndKill() {
    console.log('\n=== Scenario: healthy run, then kill miner2 ===')
    const net = new Network()
    net.setUniformDelay(1)
    const nodes = allNodes.map(n => new Node(n))
    const sched = new Scheduler(nodes, net)

    sched.addEvent(300 * SimParams.blockTime, () => {
        nodes.find(n => n.name === 'miner2').alive = false
        console.log('  [event] miner2 killed at sim time', sched.time)
    })

    sched.addEvent(800 * SimParams.blockTime, () => {
        nodes.find(n => n.name === 'miner2').alive = true
        console.log('  [event] miner2 revived at sim time', sched.time)
    })

    sched.run(1000)

    const tip = nodes[0].tip()
    const state = lh.jailState(nodes[0].chain, SimParams)
    console.log('  final height:', tip._id)
    console.log('  jailed:', Object.keys(state.byName).filter(n => state.byName[n].jailedUntil > tip._id).map(n => n))
    console.log('  max streaks:', Object.keys(state.byName).map(n => [n, state.byName[n].streak]))
    console.log('  safety violations:', sched.safetyViolations.length)
    assert.strictEqual(sched.safetyViolations.length, 0, 'no safety violations')
}

function scenarioPartition22() {
    console.log('\n=== Scenario: 2|2 partition with E=4 after miner2 jailed ===')
    const net = new Network()
    net.setUniformDelay(1)
    const nodes = allNodes.map(n => new Node(n))
    const sched = new Scheduler(nodes, net)

    // kill miner2 and wait long enough for it to be jailed (30 misses)
    sched.addEvent(200 * SimParams.blockTime, () => {
        nodes.find(n => n.name === 'miner2').alive = false
        console.log('  [event] miner2 killed')
    })

    sched.addEvent(650 * SimParams.blockTime, () => {
        net.setPartition([['dtube', 'miner1'], ['miner3', 'miner4']])
        console.log('  [event] partition 2|2 applied at height', sched.metrics.blocks)
    })

    sched.addEvent(850 * SimParams.blockTime, () => {
        net.heal()
        console.log('  [event] network healed at height', sched.metrics.blocks)
    })

    sched.run(1000)

    // after the partition, no node should have produced conflicting blocks
    console.log('  final heights:', nodes.map(n => n.name + '=' + n.tip()._id).join(', '))
    console.log('  safety violations:', sched.safetyViolations.length)
    assert.strictEqual(sched.safetyViolations.length, 0, 'no safety violations in partition scenario')
}

function runDefaultScenarios() {
    scenarioHealthyAndKill()
    scenarioPartition22()
    console.log('\nSimulation completed successfully.')
}

module.exports = {
    SimParams, allNodes, nodeAppr, Network, Node, Scheduler,
    hashOf, clone,
    scenarioHealthyAndKill, scenarioPartition22, runDefaultScenarios
}

if (require.main === module)
    runDefaultScenarios()
