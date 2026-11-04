// == Structured event log (in-process, bounded) ==
//
// A small ring buffer of structured events so operators — and the Discord
// watcher — can react to things that are visible only in the logs today: halt
// breaker firing, force finalize, block collisions, leader jail/un-jail,
// recovery start/stop. It is deliberately passive: emitting NEVER throws and
// NEVER affects consensus; it only records.
//
// Read it via GET /events (?since=<seq>&limit=<n>&type=a,b) and via the
// avalon_event_total{type=...} / avalon_last_event_timestamp_seconds{type=...}
// metrics in GET /metrics.

const MAX = parseInt(process.env.EVENT_BUFFER_MAX || '2000', 10)

const buf = []
const counters = new Map() // type -> count
const lastTs = new Map()   // type -> epoch ms
let seq = 0

const events = {
    // emit(type, level, data) -> event | null. level: 'info' | 'warn' | 'error'.
    emit: (type, level, data) => {
        try {
            const e = {
                seq: ++seq,
                ts: Date.now(),
                type: String(type),
                level: level === 'warn' || level === 'error' ? level : 'info',
                data: data || {}
            }
            buf.push(e)
            if (buf.length > MAX) buf.shift()
            counters.set(e.type, (counters.get(e.type) || 0) + 1)
            lastTs.set(e.type, e.ts)
            return e
        } catch (_) {
            return null
        }
    },

    // list({ since, limit, type }) -> events oldest-first.
    //   since: last seq the caller already has (exclusive); 0 = all buffered.
    //   limit: max events (default 100, capped at the buffer size).
    //   type:  string or array, comma-separated when a string.
    list: (opts) => {
        try {
            opts = opts || {}
            const limit = Math.min(parseInt(opts.limit, 10) || 100, MAX)
            const since = parseInt(opts.since, 10) || 0
            let types = null
            if (opts.type) {
                const arr = Array.isArray(opts.type) ? opts.type : String(opts.type).split(',')
                types = new Set(arr.map(t => t.trim()).filter(Boolean))
            }
            const out = []
            for (let i = 0; i < buf.length; i++) {
                const e = buf[i]
                if (e.seq <= since) continue
                if (types && !types.has(e.type)) continue
                out.push(e)
            }
            return out.slice(-limit)
        } catch (_) {
            return []
        }
    },

    head: () => seq,

    snapshot: () => {
        const c = {}
        for (const [k, v] of counters) c[k] = v
        const t = {}
        for (const [k, v] of lastTs) t[k] = v
        return { head: seq, counters: c, lastTs: t }
    },

    // test helper
    _reset: () => {
        buf.length = 0
        counters.clear()
        lastTs.clear()
        seq = 0
    }
}

module.exports = events
