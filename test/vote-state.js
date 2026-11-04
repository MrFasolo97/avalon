// == Vote state — persistence and INV-1 across restarts ==
// node test/vote-state.js

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const voteState = require('../src/voteState')

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-vote-state-'))
let seq = 0
function tmpFile() {
    seq++
    return path.join(tmpRoot, 'run' + seq, 'state', 'vote_state.json')
}

console.log('=== Vote state ===\n')

console.log('--- persistence ---')

test('save creates the directory tree and the file', () => {
    const file = tmpFile()
    const rec = voteState.save(file, { height: 42, round: 0, hash: 'abc' })
    assert.strictEqual(rec.height, 42)
    assert.ok(fs.existsSync(file))
    assert.ok(rec.ts > 0)
})

test('save is atomic: no temp file survives a successful write', () => {
    const file = tmpFile()
    voteState.save(file, { height: 1, round: 0, hash: 'a' })
    const leftovers = fs.readdirSync(path.dirname(file)).filter(f => f.indexOf('.tmp') !== -1)
    assert.deepStrictEqual(leftovers, [])
})

test('load returns exactly what save wrote', () => {
    const file = tmpFile()
    voteState.save(file, { height: 7, round: 1, hash: 'ff00' })
    const back = voteState.load(file)
    assert.strictEqual(back.present, true)
    assert.strictEqual(back.corrupt, false)
    assert.strictEqual(back.record.height, 7)
    assert.strictEqual(back.record.round, 1)
    assert.strictEqual(back.record.hash, 'ff00')
})

test('a missing file is absent, not corrupt', () => {
    const back = voteState.load(tmpFile())
    assert.strictEqual(back.present, false)
    assert.strictEqual(back.corrupt, false)
    assert.strictEqual(back.record.height, -1)
})

test('a corrupt file is flagged so a strict caller can fail closed', () => {
    const file = tmpFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ this is not json')
    const back = voteState.load(file)
    assert.strictEqual(back.corrupt, true)
    assert.strictEqual(back.present, false)
})

test('unknown fields and wrong types are normalised away', () => {
    const file = tmpFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ height: 'x', round: 2, hash: 7, extra: true }))
    const back = voteState.load(file)
    assert.strictEqual(back.record.height, -1)
    assert.strictEqual(back.record.round, 2)
    assert.strictEqual(back.record.hash, null)
})

test('saveVerified round-trips and throws if the file does not match', () => {
    const file = tmpFile()
    voteState.saveVerified(file, { height: 3, round: 0, hash: 'cafe' })
    assert.strictEqual(voteState.load(file).record.hash, 'cafe')
})

test('reset deletes the file and tolerates a missing one', () => {
    const file = tmpFile()
    voteState.save(file, { height: 3, round: 0, hash: 'cafe' })
    assert.strictEqual(voteState.reset(file), true)
    assert.strictEqual(fs.existsSync(file), false)
    assert.strictEqual(voteState.reset(file), true)
})

console.log('\n--- decide(): INV-1 across restarts ---')

const prev = { height: 10, round: 0, hash: 'A' }

test('first vote is allowed', () => {
    assert.deepStrictEqual(voteState.decide(voteState.emptyRecord(), { height: 1, round: 0, hash: 'A' }),
        { allow: true, reason: 'first-vote' })
})

test('a new height is allowed', () => {
    assert.strictEqual(voteState.decide(prev, { height: 11, round: 0, hash: 'B' }).allow, true)
})

test('going backwards in height is refused', () => {
    const res = voteState.decide(prev, { height: 9, round: 1, hash: 'Z' })
    assert.strictEqual(res.allow, false)
    assert.strictEqual(res.reason, 'stale-height')
})

test('the next phase at the same height is allowed', () => {
    assert.deepStrictEqual(voteState.decide(prev, { height: 10, round: 1, hash: 'A' }),
        { allow: true, reason: 'next-phase' })
})

test('an earlier phase at the same height is refused', () => {
    const atCommit = { height: 10, round: 1, hash: 'A' }
    assert.strictEqual(voteState.decide(atCommit, { height: 10, round: 0, hash: 'A' }).reason, 'stale-phase')
})

test('re-voting the same hash at the same phase is a duplicate, not an equivocation', () => {
    assert.strictEqual(voteState.decide(prev, { height: 10, round: 0, hash: 'A' }).reason, 'duplicate')
})

test('a different hash at the same phase is an equivocation', () => {
    const res = voteState.decide(prev, { height: 10, round: 0, hash: 'B' })
    assert.strictEqual(res.allow, false)
    assert.strictEqual(res.reason, 'equivocation')
})

test('malformed input is refused', () => {
    assert.strictEqual(voteState.decide(prev, null).allow, false)
    assert.strictEqual(voteState.decide(prev, { height: 10 }).allow, false)
    assert.strictEqual(voteState.decide(prev, { height: 10.5, round: 0, hash: 'A' }).allow, false)
})

console.log('\n--- restart simulation ---')

test('a restart cannot reopen the double-vote window', () => {
    const file = tmpFile()
    // before restart: precommit A at height 500
    assert.strictEqual(voteState.decide(voteState.load(file).record, { height: 500, round: 0, hash: 'A' }).allow, true)
    voteState.save(file, { height: 500, round: 0, hash: 'A' })

    // process dies here; a new instance boots and loads the file
    const afterRestart = voteState.load(file)
    assert.strictEqual(afterRestart.present, true)
    const second = voteState.decide(afterRestart.record, { height: 500, round: 0, hash: 'B' })
    assert.strictEqual(second.allow, false)
    assert.strictEqual(second.reason, 'equivocation')
})

test('a crashed temp file does not hide the committed record', () => {
    const file = tmpFile()
    voteState.save(file, { height: 500, round: 0, hash: 'A' })
    fs.writeFileSync(file + '.999.tmp', '{"height":500,"round":0,"hash":"B"}')
    assert.strictEqual(voteState.load(file).record.hash, 'A')
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + ' (' + passed + ' passed, ' + failed + ' failed)')
fs.rmSync(tmpRoot, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
