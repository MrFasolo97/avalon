#!/usr/bin/env node
// == Upgrade preflight — the flag-day readiness gates, automated ==
//
// Implements the online gates of doc/mainnet-deployment-and-rollback.md §5
// (plan §8.2), so the coordinator does not have to eyeball every node:
//
//   G-1 version census     : every node reports the same /version
//   G-2 schedule agreement : while nodes share a head height, /debug/statehash
//                            agrees (catches F6/F7 before the strict flag day)
//
// The log-based gate (G-3 "skips mismatch") and the backup gate (G-5) are local
// to each node: G-3 is `grep "skips mismatch" <log>` and G-5 is the S0 snapshot.
//
// Usage:
//   node scripts/upgrade-preflight.js --nodes http://a:3001,http://b:3001
//   AVALON_URLS=http://a:3001,http://b:3001 node scripts/upgrade-preflight.js
//
// Options:
//   --nodes <url,url,...>   node base URLs (default: $AVALON_URLS)
//   --minutes <n>           observation window for G-2 (default 5)
//   --interval-ms <n>       poll interval (default 15000)
//   --min-aligned <n>       aligned samples required to pass G-2 (default 3)
//   --json                  machine-readable output
//   --help
//
// Exit code: 0 if every gate passed, 1 otherwise. No DB or chain access.

const DEFAULT_INTERVAL_MS = 15000
const DEFAULT_MINUTES = 5
const DEFAULT_MIN_ALIGNED = 3

function fail(msg) {
    process.stderr.write('preflight: ' + msg + '\n')
    process.exit(2)
}

function arg(flag, fallback) {
    const i = process.argv.indexOf(flag)
    if (i === -1) return fallback
    if (i + 1 >= process.argv.length) fail(flag + ' needs a value')
    return process.argv[i + 1]
}

const HELP = process.argv.includes('--help') || process.argv.includes('-h')
if (HELP) {
    process.stdout.write(require('fs').readFileSync(__filename, 'utf8')
        .split('\n').slice(1, 30).join('\n') + '\n')
    process.exit(0)
}

const nodesArg = arg('--nodes', process.env.AVALON_URLS || '')
const nodes = nodesArg.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
if (nodes.length === 0) fail('no nodes: pass --nodes <url,url,...> or set AVALON_URLS')
if (nodes.length < 2)
    process.stdout.write('preflight: WARNING single node — G-2 needs at least 2 to compare\n')

const minutes = Number(arg('--minutes', DEFAULT_MINUTES))
const intervalMs = Number(arg('--interval-ms', DEFAULT_INTERVAL_MS))
const minAligned = Number(arg('--min-aligned', DEFAULT_MIN_ALIGNED))
const asJson = process.argv.includes('--json')

async function get(url, path) {
    const res = await fetch(url + path, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status)
    return res.text()
}

async function getJson(url, path) {
    return JSON.parse(await get(url, path))
}

async function versionOf(url) {
    try {
        return (await getJson(url, '/version')).version
    } catch (e) {
        return 'UNREACHABLE(' + e.message + ')'
    }
}

async function heightOf(url) {
    try {
        const t = await get(url, '/count')
        const m = t.match(/\d+/)
        return m ? Number(m[0]) : null
    } catch (e) {
        return null
    }
}

async function statehashOf(url) {
    try {
        return (await getJson(url, '/debug/statehash')).stateHash || null
    } catch (e) {
        return null
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
    const report = { nodes, gates: {}, ok: true }

    // ---- G-1 version census ----
    const versions = {}
    for (const n of nodes) versions[n] = await versionOf(n)
    const distinct = Array.from(new Set(Object.values(versions)))
    const censusOk = distinct.length === 1 && !distinct[0].startsWith('UNREACHABLE')
    report.gates.versionCensus = { ok: censusOk, versions }
    report.ok = report.ok && censusOk

    if (!asJson) {
        process.stdout.write('G-1 version census:\n')
        for (const n of nodes) process.stdout.write('  ' + versions[n] + '  ' + n + '\n')
        if (censusOk) process.stdout.write('  PASS (all nodes report ' + distinct[0] + ')\n')
        else process.stdout.write('  FAIL — nodes disagree: ' + distinct.join(', ') + '\n')
    }

    // ---- G-2 schedule / statehash agreement at a common height ----
    const deadline = Date.now() + minutes * 60 * 1000
    let aligned = 0
    let mismatches = 0
    const mismatchSamples = []
    while (Date.now() < deadline) {
        const heights = {}
        for (const n of nodes) heights[n] = await heightOf(n)
        const hs = Object.values(heights)
        const same = hs.length > 0 && hs.every(h => h !== null && h === hs[0])
        if (same) {
            aligned++
            const hashes = {}
            for (const n of nodes) hashes[n] = await statehashOf(n)
            const uniq = Array.from(new Set(Object.values(hashes)))
            if (uniq.length !== 1) {
                mismatches++
                mismatchSamples.push({ height: hs[0], hashes })
                if (!asJson) process.stdout.write('  mismatch at height ' + hs[0] + ': '
                    + nodes.map(n => n + '=' + (hashes[n] || 'null').slice(0, 12)).join(' ') + '\n')
            }
        }
        if (asJson) break
        if (Date.now() < deadline) await sleep(intervalMs)
    }
    const agreementOk = mismatches === 0 && aligned >= minAligned
    report.gates.scheduleAgreement = { ok: agreementOk, aligned, mismatches, minAligned, mismatchSamples }
    report.ok = report.ok && agreementOk

    if (!asJson) {
        process.stdout.write('G-2 schedule agreement: ' + aligned + ' aligned sample(s), '
            + mismatches + ' mismatch(es) (need >= ' + minAligned + ' aligned, 0 mismatch)\n')
        process.stdout.write('  ' + (agreementOk ? 'PASS' : 'FAIL') + '\n')
    }

    if (asJson) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    else process.stdout.write('\npreflight: ' + (report.ok ? 'ALL GATES PASS' : 'GATES FAILED') + '\n')
    process.exit(report.ok ? 0 : 1)
}

main().catch(e => fail(e.message))
