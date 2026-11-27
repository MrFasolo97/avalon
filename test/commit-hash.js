/* eslint-disable no-magic-numbers */
// == R6: runtime build commit resolution ==
// node test/commit-hash.js
//
// /version and NODE_STATUS must identify the exact artifact, not a hardcoded
// hash. Inject env/exec so every branch is exercised without spawning git.

const assert = require('assert')
const commitHash = require('../src/commitHash')

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

const noopExec = () => '  deadbeef\n'

test('GIT_COMMIT wins and is trimmed', () => {
    assert.strictEqual(commitHash.resolve({
        env: { GIT_COMMIT: '  abc123  ', AVALON_COMMIT: 'other' }, exec: noopExec
    }), 'abc123')
})

test('blank GIT_COMMIT falls back to AVALON_COMMIT', () => {
    assert.strictEqual(commitHash.resolve({
        env: { GIT_COMMIT: ' \t ', AVALON_COMMIT: ' feedbeef\n' }, exec: noopExec
    }), 'feedbeef')
})

test('both env sources blank falls back to git', () => {
    assert.strictEqual(commitHash.resolve({
        env: {}, exec: () => '  cafebabe\n'
    }), 'cafebabe')
})

test('git returning only whitespace falls back to unknown', () => {
    assert.strictEqual(commitHash.resolve({
        env: {}, exec: () => ' \n'
    }), 'unknown')
})

test('git failure falls back to unknown', () => {
    assert.strictEqual(commitHash.resolve({
        env: {}, exec: () => { throw new Error('not a git checkout') }
    }), 'unknown')
})

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED')
    + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
