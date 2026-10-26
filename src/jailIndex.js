// jailIndex.js — persistent cache for the leader jail state
//
// Computing jailState requires scanning up to `lookback` blocks. On mainnet
// this is ~5000 blocks, which is fine in memory but wasteful on every restart.
// This module persists the computed state at the chain tip and reloads it on
// startup when the tip hash still matches.
//
// Path: /avalon/config/testnet-keys/jail-index-<NODE_OWNER>.json

const fs = require('fs')
const path = require('path')

const INDEX_VERSION = 1

function filePath() {
    const owner = process.env.NODE_OWNER || 'unknown'
    const dir = process.env.COMMIT_LOCK_DIR || '/avalon/config/testnet-keys'
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'jail-index-' + owner + '.json')
}

function load() {
    const f = filePath()
    if (!fs.existsSync(f)) return null
    try {
        const idx = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (!idx || idx.version !== INDEX_VERSION) {
            process.stderr.write('[jailIndex] version mismatch, recomputing\n')
            return null
        }
        if (!idx.tipHash || typeof idx.tipHeight !== 'number' || !idx.state) {
            process.stderr.write('[jailIndex] malformed index, recomputing\n')
            return null
        }
        return idx
    } catch (e) {
        process.stderr.write('[jailIndex] failed to load index: ' + e.message + '\n')
        return null
    }
}

function save(tipHeight, tipHash, state) {
    const f = filePath()
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({
        version: INDEX_VERSION,
        tipHeight,
        tipHash,
        state,
        savedAt: Date.now()
    }, null, 2))
    fs.renameSync(tmp, f)
}

module.exports = { load, save, filePath }
