// == Unit-test runner ==
// `npm test`
//
// Runs every test file in a fresh child process so a crashing module cannot
// hide the results of the others, and exits with a non-zero code if any suite
// fails. No DB, no network, no globals setup required beyond what each test
// stubs for itself.

const { spawnSync } = require('child_process')
const path = require('path')

const tests = [
    'quorum-lock.js',
    'qc-shadow.js',
    'qc-wiring.js',
    'qc-justify.js',
    'vote-state.js',
    'observer-finalize.js',
    'monotone-ff.js',
    'leader-health.js',
    'skip-attestation.js',
    'events.js',
    'audit-fixes.js',
    'force-finalize.js',
    'supply-anchor.js',
    'pending-blocks.js',
    'force-finalize-fetch.js',
    'halt-breaker.js',
    'consensus-endpoints.js',
    'schedule-endpoint.js',
    'block-rank.js',
    'schedule-persist.js',
    'layer-h.js'
]

let failed = 0
let passed = 0

for (const t of tests) {
    console.log('\n==> running ' + t)
    const res = spawnSync(process.execPath, [path.join(__dirname, t)], {
        stdio: 'inherit',
        timeout: 60000
    })
    if (res.status !== 0) {
        failed++
        console.log('==> ' + t + ' FAILED')
    } else {
        passed++
        console.log('==> ' + t + ' passed')
    }
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' suite(s) FAILED')
    + ' (' + passed + ' passed, ' + failed + ' failed)')
process.exit(failed === 0 ? 0 : 1)
