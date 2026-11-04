#!/usr/bin/env node
// avalon-watch.js — optional, out-of-process alert watcher for an Avalon node.
//
// Polls a node's HTTP API and posts to a Discord webhook when something looks
// wrong: the chain halted, the node is isolated, the quorum is degraded, a
// leader got jailed, the node is unreachable, or — when watching several nodes —
// two of them disagree (divergence / fork).
//
// It is deliberately EXTERNAL: no code in src/, no consensus impact. Run it as a
// sidecar / systemd unit / cron on any operator machine; delete it to disable.
//
// Env:
//   AVALON_URL           base URL of the local node        (default http://localhost:3001)
//   AVALON_WATCH_URLS    extra node URLs, comma-separated, for divergence checks (optional)
//   DISCORD_WEBHOOK_URL  Discord webhook (required to actually send)
//   WATCH_INTERVAL_MS    poll interval                      (default 15000)
//   HALT_MS              head stale this long => HALT        (default 120000)
//   MIN_PEERS            peers below this => ISOLATED        (default 1)
//   ISOLATED_MS          isolated this long => alert         (default 30000)
//   POSSBLOCKS_MAX       possBlocks backlog threshold        (default 20)
//   ALERT_COOLDOWN_MS    min gap between repeats of an alert (default 300000)
//   NODE_NAME            label used in the messages          (default the hostname)
//   DRY_RUN              1 = log to stdout instead of posting (default 0)
//
// Exit: keeps running until killed. Logs to stdout.

const http = require('http')
const https = require('https')

const DEFAULTS = {
    AVALON_URL: 'http://localhost:3001',
    WATCH_INTERVAL_MS: 15000,
    // 2 minutes: a 3 s block time stalls for ~40 blocks before this fires, so a
    // single slow block or a brief reconnect does not raise a false HALT. Tune
    // down only if you want earlier notice and accept the noise.
    HALT_MS: 120000,
    MIN_PEERS: 1,
    ISOLATED_MS: 30000,
    POSSBLOCKS_MAX: 20,
    ALERT_COOLDOWN_MS: 300000,
    NODE_NAME: require('os').hostname()
}

const num = (v, d) => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : d
}

const cfg = {
    base: process.env.AVALON_URL || DEFAULTS.AVALON_URL,
    extra: (process.env.AVALON_WATCH_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
    webhook: process.env.DISCORD_WEBHOOK_URL || '',
    interval: num(process.env.WATCH_INTERVAL_MS, DEFAULTS.WATCH_INTERVAL_MS),
    haltMs: num(process.env.HALT_MS, DEFAULTS.HALT_MS),
    minPeers: num(process.env.MIN_PEERS, DEFAULTS.MIN_PEERS),
    isolatedMs: num(process.env.ISOLATED_MS, DEFAULTS.ISOLATED_MS),
    possMax: num(process.env.POSSBLOCKS_MAX, DEFAULTS.POSSBLOCKS_MAX),
    cooldown: num(process.env.ALERT_COOLDOWN_MS, DEFAULTS.ALERT_COOLDOWN_MS),
    name: process.env.NODE_NAME || DEFAULTS.NODE_NAME,
    dryRun: process.env.DRY_RUN === '1'
}

const log = (...a) => console.log(new Date().toISOString(), '[watch]', ...a)

// ---- discord ---------------------------------------------------------------
// A POST, not a bot: outbound notifications only, no gateway, no token.
async function discord(content) {
    if (!cfg.webhook) { log('(no DISCORD_WEBHOOK_URL) would send:', content); return }
    if (cfg.dryRun) { log('(dry-run) would send:', content); return }
    try {
        const res = await fetch(cfg.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: String(content).slice(0, 1900) })
        })
        if (!res.ok && res.status !== 204)
            log('discord post failed: HTTP', res.status, await res.text().catch(() => ''))
    } catch (e) {
        log('discord post error:', e.message)
    }
}

// ---- alert state machine ---------------------------------------------------
// One entry per condition key. Fires on the OK->BAD transition, repeats at most
// every cooldown, and sends a RECOVERED message on BAD->OK.
const alerts = {}
async function setAlert(key, bad, badMsg, okMsg) {
    const now = Date.now()
    let a = alerts[key]
    if (!a) a = alerts[key] = { firing: false, last: 0 }
    if (bad) {
        if (!a.firing || now - a.last > cfg.cooldown) {
            a.firing = true
            a.last = now
            await discord(badMsg)
        }
    } else if (a.firing) {
        a.firing = false
        await discord(okMsg)
    }
}

// ---- http ------------------------------------------------------------------
async function getJSON(url, path, timeout = 5000) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeout)
    try {
        const res = await fetch(url.replace(/\/$/, '') + path, { signal: ctrl.signal })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return await res.json()
    } finally {
        clearTimeout(t)
    }
}

const hdr = () => `**${cfg.name}** (\`${cfg.base}\`)`

// ---- one poll --------------------------------------------------------------
async function poll() {
    const now = Date.now()
    let count, peers, consensus
    try {
        ;[count, peers] = await Promise.all([getJSON(cfg.base, '/count'), getJSON(cfg.base, '/peers')])
        consensus = await getJSON(cfg.base, '/consensus').catch(() => null)
        await setAlert('down', false, '', `🟢 ${hdr()} NODE RECOVERED — API reachable again`)
    } catch (e) {
        await setAlert('down', true,
            `🔴 ${hdr()} NODE UNREACHABLE — ${e.message}`, '')
        return
    }

    const head = count && Number.isInteger(count.count) ? count.count : (count && count.count)
    const peerCount = Array.isArray(peers) ? peers.length : 0

    // --- chain halted ---
    if (head !== cfg.lastHead) { cfg.lastHead = head; cfg.stallSince = now }
    else if (!cfg.stallSince) cfg.stallSince = now
    const stalledFor = now - (cfg.stallSince || now)
    await setAlert('halt', stalledFor > cfg.haltMs,
        `🔴 ${hdr()} CHAIN HALTED — head stuck at ${head} for ${Math.round(stalledFor / 1000)}s` +
        (consensus ? ` (active ${fmtList(consensus.activeLeaders)}, q=${consensus.quorumThreshold})` : ''),
        `🟢 ${hdr()} chain advancing again at ${head}`)

    // --- isolated ---
    if (peerCount < cfg.minPeers) {
        if (!cfg.isoSince) cfg.isoSince = now
    } else cfg.isoSince = 0
    const isoFor = cfg.isoSince ? now - cfg.isoSince : 0
    await setAlert('isolated', isoFor > cfg.isolatedMs,
        `🔴 ${hdr()} ISOLATED — ${peerCount} peer(s) for ${Math.round(isoFor / 1000)}s`,
        `🟢 ${hdr()} peers back (${peerCount})`)

    if (!consensus) return

    // --- quorum degraded ---
    const eligible = Array.isArray(consensus.eligibleLeaders) ? consensus.eligibleLeaders.length : null
    const leaders = Array.isArray(consensus.activeLeaders) ? consensus.activeLeaders.length : null
    if (eligible !== null && leaders !== null) {
        await setAlert('quorum', eligible < leaders,
            `🟠 ${hdr()} QUORUM DEGRADED — eligible ${eligible}/${leaders} ` +
            `(q=${consensus.quorumThreshold}); ${fmtList(consensus.eligibleLeaders)}`,
            `🟢 ${hdr()} quorum restored (${eligible}/${leaders})`)
    }

    // --- possBlocks backlog (consensus not converging) ---
    const poss = Number.isInteger(consensus.possBlocksCount) ? consensus.possBlocksCount : 0
    await setAlert('possblocks', poss > cfg.possMax,
        `🟠 ${hdr()} possBlocks backlog ${poss} > ${cfg.possMax} at height ${head}` +
        ` (consensus slow / a height not converging)`,
        `🟢 ${hdr()} possBlocks backlog cleared`)

    // --- leaders jailed ---
    const jailed = Object.entries(consensus.leaderHealth || {})
        .filter(([, v]) => v && v.jailed).map(([k]) => k)
    await setAlert('jail', jailed.length > 0,
        `🟠 ${hdr()} LEADER(S) JAILED — ${jailed.join(', ')} at height ${head}`,
        `🟢 ${hdr()} no leaders jailed`)

    // --- divergence across watched nodes ---
    if (cfg.extra.length) {
        const urls = [cfg.base, ...cfg.extra]
        const heads = await Promise.all(urls.map(u => getJSON(u, '/count').catch(() => null)))
        const known = heads.map((h, i) => ({ url: urls[i], head: h ? h.count : null }))
        const sameHeight = known.every(n => n.head !== null && n.head === known[0].head)
        const hashes = sameHeight
            ? await Promise.all(urls.map(u => getJSON(u, '/debug/statehash').then(j => j.stateHash).catch(() => null)))
            : []
        const diverge = sameHeight
            ? hashes.some(h => h && hashes[0] && h !== hashes[0])
            : known.filter(n => n.head !== null).length > 1 &&
              new Set(known.map(n => n.head)).size > 1 &&
              (Math.max(...known.map(n => n.head || 0)) - Math.min(...known.map(n => n.head || 0))) > 20
        await setAlert('diverge', diverge,
            `🔴 ${hdr()} DIVERGENCE — watched nodes disagree: ` +
            known.map(n => `${short(n.url)}=${n.head}`).join(' '),
            `🟢 ${hdr()} watched nodes agree again`)
    }
}

const short = u => u.replace(/^https?:\/\//, '')
const fmtList = a => Array.isArray(a) ? '[' + a.map(x => (x && x.name) || x).join(',') + ']' : '?'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
    log('starting — url=' + cfg.base + ' extra=[' + cfg.extra.join(',') + ']' +
        ' webhook=' + (cfg.webhook ? 'set' : 'MISSING') + ' dryRun=' + cfg.dryRun)
    if (!cfg.webhook && !cfg.dryRun)
        log('WARNING: no DISCORD_WEBHOOK_URL — alerts will only be logged')
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try { await poll() } catch (e) { log('poll error:', e.message) }
        await sleep(cfg.interval)
    }
}

if (require.main === module) main()
module.exports = { poll }
