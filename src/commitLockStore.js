// commitLockStore.js — persistent per-height commit lock
//
// A node commits at most one hash per height. The in-memory lock is backed by a
// JSONL file so that a crash + restart does not allow double-signing at a height
// that was already committed before the crash.
//
// Storage path: /avalon/config/testnet-keys/commit-locks-<NODE_OWNER>.jsonl
// (uses the existing jail_config volume, but the file is per node).

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
    for (const line of lines) {
        if (!line.trim()) continue
        try {
            const e = JSON.parse(line)
            if (e && typeof e.height === 'number' && e.hash)
                locks[e.height] = { hash: e.hash, miner: e.miner || null }
        } catch (err) {
            // skip corrupted line
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
    const tmp = f + '.tmp'
    const out = fs.createWriteStream(tmp)
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    for (const line of lines) {
        if (!line.trim()) continue
        try {
            const e = JSON.parse(line)
            if (e.height >= finalizedHeight - keep) out.write(line + '\n')
        } catch (err) {}
    }
    out.end()
    // createWriteStream is async, but for a small file the event loop will drain
    // quickly; rename on 'close' to be safe
    out.on('close', () => {
        try { fs.renameSync(tmp, f) } catch (e) {}
    })
    out.on('error', () => {
        try { fs.unlinkSync(tmp) } catch (e) {}
    })
}

module.exports = { load, append, cleanup, filePath }
