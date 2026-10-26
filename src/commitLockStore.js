// commitLockStore.js — persistent per-height commit lock
//
// A node commits at most one hash per height. The in-memory lock is backed by a
// JSONL file so that a crash + restart does not allow double-signing at a height
// that was already committed before the crash.
//
// Storage path: /avalon/config/testnet-keys/commit-locks-<NODE_OWNER>.jsonl
// (uses the existing jail_config volume, but the file is per node).
//
// Design notes:
//   * append-only JSONL for durability;
//   * synchronous cleanup to avoid races with the event loop;
//   * keep the last `keep` entries to bound file size;
//   * corrupted lines are skipped but logged.

const fs = require('fs')
const path = require('path')

function filePath() {
    const owner = process.env.NODE_OWNER || 'unknown'
    const dir = process.env.COMMIT_LOCK_DIR || '/avalon/config/testnet-keys'
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'commit-locks-' + owner + '.jsonl')
}

function load() {
    const f = filePath()
    const locks = {}
    if (!fs.existsSync(f)) return locks
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        try {
            const e = JSON.parse(line)
            if (e && typeof e.height === 'number' && e.hash)
                locks[e.height] = { hash: e.hash, miner: e.miner || null }
        } catch (err) {
            // skip corrupted line but leave a trace
            process.stderr.write('[commitLockStore] corrupted line ' + (i + 1) + ' in ' + f + '\n')
        }
    }
    return locks
}

function append(height, hash, miner) {
    const f = filePath()
    const record = JSON.stringify({ height, hash, miner, ts: Date.now() }) + '\n'
    fs.appendFileSync(f, record)
}

// Keep only the last `keep` entries to avoid unbounded growth. Called when a
// block becomes final: everything older than the finalized height is irrelevant.
function cleanup(finalizedHeight, keep = 1000) {
    const f = filePath()
    if (!fs.existsSync(f)) return
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    const kept = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        try {
            const e = JSON.parse(line)
            if (e.height >= finalizedHeight - keep)
                kept.push(line)
        } catch (err) {
            process.stderr.write('[commitLockStore] corrupted line ' + (i + 1) + ' in ' + f + '\n')
        }
    }
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''))
    fs.renameSync(tmp, f)
}

// Verify that the on-disk store is consistent with the in-memory locks.
function verify(locks) {
    const fromDisk = load()
    for (const h of Object.keys(locks)) {
        const disk = fromDisk[h]
        const mem = locks[h]
        if (!disk || disk.hash !== mem.hash)
            throw new Error('commit lock mismatch at height ' + h + ': memory=' + mem.hash + ' disk=' + (disk && disk.hash))
    }
    return true
}

module.exports = { load, append, cleanup, verify, filePath }
