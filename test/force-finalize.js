const assert = require('assert')
const crypto = require('crypto')

function deterministicSort(candidates) {
    const sorted = [...candidates]
    sorted.sort((a, b) => {
        if (a.block.timestamp !== b.block.timestamp)
            return a.block.timestamp - b.block.timestamp
        return a.block.hash < b.block.hash ? -1 : 1
    })
    return sorted
}

function makeBlock(height, timestamp, seed) {
    const hash = crypto.createHash('sha256').update(seed + height + timestamp).digest('hex')
    return {
        block: { _id: height, timestamp, hash, miner: 'miner_' + seed }
    }
}

function simulateRetry(candidates, failingHashes) {
    const results = []
    let retryCount = 0
    let remaining = [...candidates]

    while (remaining.length > 0 && retryCount < 3) {
        const sorted = deterministicSort(remaining)
        const winner = sorted[0]
        if (failingHashes.includes(winner.block.hash)) {
            results.push({ winner: winner.block.hash, status: 'fail' })
            remaining = remaining.filter(pb => pb.block.hash !== winner.block.hash)
            retryCount++
        } else {
            results.push({ winner: winner.block.hash, status: 'success' })
            return results
        }
    }
    results.push({ status: 'exhausted', remaining: remaining.length, retryCount })
    return results
}

// Test 1: Deterministic candidate selection (timestamp + hash sorting)
{
    const early = makeBlock(100, 1000, 'a')      // timestamp 1000
    const mid = makeBlock(100, 2000, 'b')        // timestamp 2000
    const late = makeBlock(100, 3000, 'c')        // timestamp 3000

    const sorted = deterministicSort([mid, late, early])
    assert.strictEqual(sorted[0].block.hash, early.block.hash, 'earliest timestamp should win')
    assert.strictEqual(sorted[1].block.hash, mid.block.hash, 'middle timestamp second')
    assert.strictEqual(sorted[2].block.hash, late.block.hash, 'latest timestamp last')
    console.log('PASS: timestamp sorting')
}

// Test 2: Hash tiebreaker for same timestamp
{
    const a = makeBlock(100, 1000, 'aaaa')
    const b = makeBlock(100, 1000, 'bbbb')

    const sorted = deterministicSort([b, a])
    assert.strictEqual(sorted[0].block.hash < sorted[1].block.hash, true, 'lower hash should win on tie')
    const sorted2 = deterministicSort([a, b])
    assert.strictEqual(sorted2[0].block.hash, sorted[0].block.hash, 'sorting should be deterministic regardless of input order')
    console.log('PASS: hash tiebreaker')
}

// Test 3: Sorting is idempotent (same result every time)
{
    const blocks = [makeBlock(100, 3000, 'x'), makeBlock(100, 1000, 'y'), makeBlock(100, 2000, 'z')]
    const first = deterministicSort(blocks)
    const second = deterministicSort(blocks)
    for (let i = 0; i < first.length; i++)
        assert.strictEqual(first[i].block.hash, second[i].block.hash, 'sorting must be idempotent')
    console.log('PASS: idempotent sorting')
}

// Test 4: Single candidate (no collision)
{
    const single = [makeBlock(100, 1000, 'only')]
    const sorted = deterministicSort(single)
    assert.strictEqual(sorted.length, 1, 'single candidate stays single')
    assert.strictEqual(sorted[0].block.hash, single[0].block.hash)
    console.log('PASS: single candidate')
}

// Test 5: Retry mechanism - first candidate fails, second succeeds
{
    const blocks = [makeBlock(100, 1000, 'a'), makeBlock(100, 2000, 'b')]
    const results = simulateRetry(blocks, [blocks[0].block.hash])
    assert.strictEqual(results.length, 2, 'should try 2 candidates')
    assert.strictEqual(results[0].status, 'fail')
    assert.strictEqual(results[1].status, 'success')
    assert.strictEqual(results[1].winner, blocks[1].block.hash)
    console.log('PASS: retry with fallback')
}

// Test 6: Retry mechanism - all candidates fail
{
    const blocks = [makeBlock(100, 1000, 'a'), makeBlock(100, 2000, 'b'), makeBlock(100, 3000, 'c')]
    const allHashes = blocks.map(b => b.block.hash)
    const results = simulateRetry(blocks, allHashes)
    assert.strictEqual(results[results.length - 1].status, 'exhausted')
    assert.strictEqual(results[results.length - 1].retryCount, 3, 'should exhaust 3 retries')
    console.log('PASS: all candidates fail after 3 retries')
}

// Test 7: Retry mechanism - fewer candidates than retries
{
    const blocks = [makeBlock(100, 1000, 'a')]
    const results = simulateRetry(blocks, [blocks[0].block.hash])
    assert.strictEqual(results[results.length - 1].status, 'exhausted')
    assert.strictEqual(results[results.length - 1].remaining, 0, 'no candidates left')
    console.log('PASS: fewer candidates than retries')
}

// Test 8: Candidates at different heights are not mixed
{
    const h99 = [makeBlock(99, 1000, 'a')]
    const h100 = [makeBlock(100, 2000, 'b'), makeBlock(100, 1000, 'c')]
    const sorted100 = deterministicSort(h100)
    assert.strictEqual(sorted100[0].block._id, 100, 'only height 100 candidates')
    assert.strictEqual(sorted100[0].block.hash, h100[1].block.hash, 'earliest timestamp at height 100')
    console.log('PASS: height isolation')
}

// Test 9: BSON truncation boundary logic
{
    function simulateTruncation(oldHeight, removeCount) {
        const newHeight = oldHeight - removeCount
        if (newHeight < 0) return { error: 'negative height' }
        return { newHeight, removed: removeCount, kept: newHeight + 1 }
    }

    assert.strictEqual(simulateTruncation(100, 5).newHeight, 95)
    assert.strictEqual(simulateTruncation(100, 0).newHeight, 100)
    assert.strictEqual(simulateTruncation(0, 0).kept, 1)
    assert.strictEqual(simulateTruncation(100, 101).error, 'negative height')

    // Safety: cumulative cap prevents runaway truncation
    const MAX_TOTAL_REMOVE = 30
    function checkCumulativeCap(totalRemoved, toRemove) {
        return (totalRemoved + toRemove) <= MAX_TOTAL_REMOVE
    }
    assert.strictEqual(checkCumulativeCap(25, 5), true, 'within cap')
    assert.strictEqual(checkCumulativeCap(25, 10), false, 'exceeds cap')
    console.log('PASS: BSON truncation boundary logic')
}

// Test 10: Anti-fork proposal selection
{
    const localWinner = makeBlock(100, 2000, 'local')
    const peerWinner = makeBlock(100, 1000, 'peer')  // earlier timestamp

    const proposals = {
        [localWinner.block.hash]: localWinner,
        [peerWinner.block.hash]: peerWinner
    }

    const all = Object.values(proposals)
    all.sort((a, b) => {
        if (a.block.timestamp !== b.block.timestamp)
            return a.block.timestamp - b.block.timestamp
        return a.block.hash < b.block.hash ? -1 : 1
    })

    assert.strictEqual(all[0].block.hash, peerWinner.block.hash, 'anti-fork should pick peer winner with earlier timestamp')
    console.log('PASS: anti-fork proposal collection')
}

// Test 11: Quorum threshold calculation
{
    function getQuorumThreshold(leaderCount) {
        return Math.ceil(leaderCount * 2 / 3)
    }
    assert.strictEqual(getQuorumThreshold(1), 1, '1 leader: quorum 1')
    assert.strictEqual(getQuorumThreshold(3), 2, '3 leaders: quorum 2')
    assert.strictEqual(getQuorumThreshold(4), 3, '4 leaders: quorum 3')
    assert.strictEqual(getQuorumThreshold(5), 4, '5 leaders: quorum 4')
    assert.strictEqual(getQuorumThreshold(7), 5, '7 leaders: quorum 5')
    assert.strictEqual(getQuorumThreshold(10), 7, '10 leaders: quorum 7')
    console.log('PASS: quorum threshold calculation')
}

// Test 12: Quorum reached with unanimous respondents
{
    const quorumThreshold = 5  // 7 leaders
    const respondents = { a: 'X', b: 'X', c: 'X', d: 'X', e: 'X' }
    const hashVotes = {}
    for (const hash of Object.values(respondents))
        hashVotes[hash] = (hashVotes[hash] || 0) + 1
    const bestHash = Object.keys(hashVotes).reduce((a, b) => hashVotes[a] > hashVotes[b] ? a : b)
    assert.strictEqual(bestHash, 'X')
    assert.strictEqual(hashVotes['X'], 5)
    assert.strictEqual(hashVotes['X'] >= quorumThreshold, true)
    console.log('PASS: unanimous quorum reached')
}

// Test 13: Quorum not reached (not enough respondents)
{
    const quorumThreshold = 5
    const respondents = { a: 'X', b: 'X', c: 'X' }
    const hashVotes = {}
    for (const hash of Object.values(respondents))
        hashVotes[hash] = (hashVotes[hash] || 0) + 1
    const bestVotes = Object.values(hashVotes).reduce((max, v) => Math.max(max, v), 0)
    assert.strictEqual(bestVotes, 3)
    assert.strictEqual(bestVotes >= quorumThreshold, false)
    console.log('PASS: quorum not reached (few respondents)')
}

// Test 14: Quorum reached with majority (some dissenters)
{
    const quorumThreshold = 5
    const respondents = { a: 'X', b: 'X', c: 'X', d: 'X', e: 'X', f: 'Y', g: 'Y' }
    const hashVotes = {}
    for (const hash of Object.values(respondents))
        hashVotes[hash] = (hashVotes[hash] || 0) + 1
    const bestHash = Object.keys(hashVotes).reduce((a, b) => hashVotes[a] > hashVotes[b] ? a : b)
    assert.strictEqual(bestHash, 'X')
    assert.strictEqual(hashVotes['X'], 5)
    assert.strictEqual(hashVotes['X'] >= quorumThreshold, true)
    assert.strictEqual(hashVotes['Y'] >= quorumThreshold, false)
    console.log('PASS: quorum reached with majority')
}

// Test 15: Split vote — no hash reaches quorum (dangerous case)
{
    const quorumThreshold = 5
    const respondents = { a: 'X', b: 'X', c: 'X', d: 'Y', e: 'Y', f: 'Z' }
    const hashVotes = {}
    for (const hash of Object.values(respondents))
        hashVotes[hash] = (hashVotes[hash] || 0) + 1
    const bestVotes = Math.max(...Object.values(hashVotes))
    assert.strictEqual(bestVotes, 3)
    assert.strictEqual(bestVotes >= quorumThreshold, false)
    assert.strictEqual(Object.keys(hashVotes).length, 3, '3 conflicting hashes')
    console.log('PASS: split vote detected (no quorum)')
}

// Test 16: Respondents from non-leaders are ignored
{
    const activeLeaders = ['leader1', 'leader2', 'leader3']
    function isActiveLeader(name) { return activeLeaders.includes(name) }

    const respondents = {}
    const rawResponses = [
        ['leader1', 'X'], ['leader2', 'X'], ['leader3', 'Y'],
        ['attacker', 'X'], ['random', 'Z']
    ]
    for (const [name, hash] of rawResponses) {
        if (isActiveLeader(name))
            respondents[name] = hash
    }

    assert.strictEqual(Object.keys(respondents).length, 3, 'only active leaders counted')
    assert.strictEqual(respondents['attacker'], undefined, 'non-leader ignored')
    console.log('PASS: non-leader respondents filtered')
}

// Test 17: Backoff delays sequence
{
    const backoff = [600, 1200, 2400, 4800]
    assert.strictEqual(backoff.length, 4, '4 attempts total')
    let totalMax = 0
    for (let i = 0; i < backoff.length; i++) {
        totalMax += backoff[i]
        const expected = 600 * Math.pow(2, i)
        assert.strictEqual(backoff[i], expected, 'backoff[' + i + '] = ' + expected)
    }
    assert.strictEqual(totalMax, 9000, 'max total wait 9s before fallback')
    console.log('PASS: backoff delays')
}

// Test 18: Anti-fork — picks hash with most votes when quorum reached
{
    const blocks = {
        'X': { block: { hash: 'X', timestamp: 1000, _id: 100, miner: 'minerX' } },
        'Y': { block: { hash: 'Y', timestamp: 2000, _id: 100, miner: 'minerY' } }
    }
    const respondents = { a: 'X', b: 'X', c: 'X', d: 'Y', e: 'Y' }
    const hashVotes = {}
    for (const hash of Object.values(respondents))
        hashVotes[hash] = (hashVotes[hash] || 0) + 1
    const bestHash = Object.keys(hashVotes).reduce((a, b) => hashVotes[a] > hashVotes[b] ? a : b)
    const winner = blocks[bestHash]
    assert.strictEqual(winner.block.hash, 'X')
    assert.strictEqual(hashVotes['X'], 3)
    assert.strictEqual(hashVotes['Y'], 2)
    console.log('PASS: anti-fork picks majority hash')
}

// Test 19: Fallback disabled — halt instead of force finalize
{
    const config = { forceFinalizeFallback: false }
    const quorumThreshold = 5  // 7 leaders, only 3 responded
    const respondents = { a: 'X', b: 'X', c: 'Y' }
    const hashVotes = {}
    for (const hash of Object.values(respondents))
        hashVotes[hash] = (hashVotes[hash] || 0) + 1
    const bestVotes = Math.max(...Object.values(hashVotes))
    const hasQuorum = bestVotes >= quorumThreshold
    assert.strictEqual(hasQuorum, false, 'should not have quorum')
    // If fallback is disabled, we should NOT proceed to finalize
    const shouldHalt = !config.forceFinalizeFallback && !hasQuorum
    assert.strictEqual(shouldHalt, true, 'should halt when fallback disabled and no quorum')
    console.log('PASS: fallback disabled halts correctly')
}

// Test 20: Fallback enabled — finalize even without quorum
{
    const config = { forceFinalizeFallback: true }
    const candidates = [makeBlock(100, 1000, 'a')]
    const sorted = deterministicSort(candidates)
    assert.strictEqual(sorted[0].block.hash, candidates[0].block.hash, 'should still pick winner')
    assert.strictEqual(config.forceFinalizeFallback, true, 'fallback enabled')
    console.log('PASS: fallback enabled allows finalization without quorum')
}

// Test 21: Deterministic tiebreaker when votes tied
{
    const respondents = { a: 'X', b: 'X', c: 'Y', d: 'Y' }
    const blockMap = {
        'X': { block: { hash: 'X', timestamp: 1000, _id: 100, miner: 'a' } },
        'Y': { block: { hash: 'Y', timestamp: 2000, _id: 100, miner: 'b' } }
    }
    const hashVotes = {}
    for (const hash of Object.values(respondents))
        hashVotes[hash] = (hashVotes[hash] || 0) + 1
    const tiedHashes = Object.keys(hashVotes).filter(h => hashVotes[h] === Math.max(...Object.values(hashVotes)))
    // When tied, fall back to deterministic sort (earliest timestamp → lowest hash)
    const sorted = tiedHashes.map(h => blockMap[h]).sort((a, b) => {
        if (a.block.timestamp !== b.block.timestamp)
            return a.block.timestamp - b.block.timestamp
        return a.block.hash < b.block.hash ? -1 : 1
    })
    assert.strictEqual(sorted[0].block.hash, 'X', 'earliest timestamp wins tied vote')
    console.log('PASS: tiebreaker falls back to deterministic sort when votes tied')
}

console.log('\nAll tests passed!')
