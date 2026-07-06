const logBuffer = require('../../logBuffer')
const crypto = require('crypto')

const LOG_PAGE_ENABLED = process.env.LOG_PAGE !== '0'

const VALID_LEVELS = ['TRACE', 'DEBUG', 'PERF', 'ECON', 'CONS', 'INFO', 'WARN', 'ERROR', 'FATAL']

module.exports = {
  init: (app) => {
    if (!LOG_PAGE_ENABLED) return

    function isLogAdmin(req) {
      const headerToken = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
      const queryToken = req.query.token || ''
      const token = headerToken || queryToken
      if (!token || !process.env.LOG_ADMIN_TOKEN) return false
      try {
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(process.env.LOG_ADMIN_TOKEN))
      } catch { return false }
    }

    app.get('/logs', (req, res) => {
      if (!isLogAdmin(req)) {
        res.set('Content-Type', 'text/html; charset=utf-8')
        res.send(renderPage(false))
      } else {
        res.set('Content-Type', 'text/html; charset=utf-8')
        res.send(renderPage(true))
      }
    })

    app.get('/logs/stream', (req, res) => {
      const isAdmin = isLogAdmin(req)
      const levelParam = Array.isArray(req.query.level) ? req.query.level.join(',') : req.query.level
      const filterLevel = levelParam ? levelParam.split(',') : null
      const filterSearch = req.query.search || null

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })

      const initial = logBuffer.getLogs({ level: filterLevel, search: filterSearch, full: isAdmin })
      res.write(`data: ${JSON.stringify({ type: 'init', logs: initial })}\n\n`)

      const onLog = (entry) => {
        if (filterLevel && !filterLevel.includes(entry.level)) return
        if (filterSearch && !entry.message.toLowerCase().includes(filterSearch.toLowerCase())) return
        if (!isAdmin) {
          const { _raw, ...safe } = entry
          res.write(`data: ${JSON.stringify({ type: 'log', entry: safe })}\n\n`)
        } else {
          res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`)
        }
      }

      logBuffer.emitter.on('log', onLog)

      const keepAlive = setInterval(() => res.write(':keepalive\n\n'), 15000)

      req.on('close', () => {
        logBuffer.emitter.off('log', onLog)
        clearInterval(keepAlive)
      })
    })
  }
}

let _adminToken = typeof process !== 'undefined' ? (process.env.LOG_ADMIN_TOKEN || '') : ''

function renderPage(isAdmin) {
  const adminToken = isAdmin ? _adminToken : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Avalon Node Logs</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
<style>
  body { background: #0d1117; color: #c9d1d9; font-family: 'SFMono-Regular','Consolas','Liberation Mono',monospace; font-size: 13px; }
  .navbar { background: #161b22; border-bottom: 1px solid #30363d; }
  .log-container { height: calc(100vh - 120px); overflow-y: auto; padding: 8px 0; }
  .log-line { padding: 2px 16px; cursor: pointer; white-space: nowrap; min-height: 22px; display: flex; align-items: center; gap: 8px; }
  .log-line:hover { background: #161b22; }
  .log-line .ts { color: #8b949e; min-width: 100px; flex-shrink: 0; }
  .log-line .lvl { min-width: 52px; flex-shrink: 0; font-weight: 600; text-transform: uppercase; font-size: 11px; }
  .log-line .msg { overflow: hidden; text-overflow: ellipsis; }
  .log-line.expanded .msg { white-space: pre-wrap; word-break: break-all; }
  .level-TRACE { color: #8b949e; } .level-TRACE .lvl { color: #8b949e; }
  .level-DEBUG { color: #58a6ff; } .level-DEBUG .lvl { color: #58a6ff; }
  .level-PERF { color: #8b949e; } .level-PERF .lvl { color: #8b949e; }
  .level-ECON { color: #39d2c0; } .level-ECON .lvl { color: #39d2c0; }
  .level-CONS { color: #bc8cff; } .level-CONS .lvl { color: #bc8cff; }
  .level-INFO { color: #3fb950; } .level-INFO .lvl { color: #3fb950; }
  .level-WARN { color: #d29922; } .level-WARN .lvl { color: #d29922; }
  .level-ERROR { color: #f85149; } .level-ERROR .lvl { color: #f85149; }
  .level-FATAL { color: #f85149; font-weight: 700; } .level-FATAL .lvl { color: #f85149; font-weight: 700; }
  .btn-level { font-size: 11px; padding: 2px 8px; border-radius: 12px; margin: 2px; border: 1px solid #30363d; background: transparent; color: #8b949e; cursor: pointer; }
  .btn-level.active { color: #fff; border-color: currentColor; }
  .btn-level.active.lvl-TRACE { background: #8b949e33; color: #8b949e; }
  .btn-level.active.lvl-DEBUG { background: #58a6ff33; color: #58a6ff; }
  .btn-level.active.lvl-PERF { background: #8b949e33; color: #8b949e; }
  .btn-level.active.lvl-ECON { background: #39d2c033; color: #39d2c0; }
  .btn-level.active.lvl-CONS { background: #bc8cff33; color: #bc8cff; }
  .btn-level.active.lvl-INFO { background: #3fb95033; color: #3fb950; }
  .btn-level.active.lvl-WARN { background: #d2992233; color: #d29922; }
  .btn-level.active.lvl-ERROR { background: #f8514933; color: #f85149; }
  .btn-level.active.lvl-FATAL { background: #f8514933; color: #f85149; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 16px; border-bottom: 1px solid #30363d; background: #0d1117; position: sticky; top: 0; z-index: 10; }
  .search-input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 4px 12px; font-size: 13px; width: 260px; }
  .search-input:focus { outline: none; border-color: #58a6ff; }
  .badge-count { font-size: 10px; margin-left: 3px; opacity: 0.6; }
  .paused { border-left: 3px solid #d29922; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-track { background: #0d1117; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
  [data-bs-theme=dark] { --bs-body-color: #c9d1d9; }
  .toolbar-btn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 3px 12px; font-size: 12px; cursor: pointer; }
  .toolbar-btn:hover { background: #30363d; }
</style>
</head>
<body>
<nav class="navbar navbar-dark px-3 py-1">
  <span class="navbar-brand mb-0 h6" style="font-size:14px">&#9670; Avalon Node Logs <span id="conn-status" style="font-size:11px;font-weight:400;color:#8b949e">(connecting...)</span></span>
  <span id="log-count" style="font-size:11px;color:#8b949e">0 logs</span>
</nav>

<div class="controls" id="controls">
  <div id="level-filters" style="display:flex;flex-wrap:wrap;gap:2px">
    ${VALID_LEVELS.map(l => `<button class="btn-level active lvl-${l}" data-level="${l}">${l}</button>`).join('')}
  </div>
  <input type="text" class="search-input" id="search" placeholder="Search messages..." spellcheck="false">
  <button class="toolbar-btn" id="btn-pause">&#9654;&#65039; Pause</button>
  <button class="toolbar-btn" id="btn-clear">&#128465; Clear</button>
  <button class="toolbar-btn" id="btn-top">&#11014; Top</button>
</div>

<div class="log-container" id="log-container"></div>

<script>
const levels = ${JSON.stringify(VALID_LEVELS)}
const admin = ${isAdmin}

let logs = []
let filtered = []
let activeLevels = new Set(levels)
let searchQuery = ''
let paused = false
let autoScroll = true

const container = document.getElementById('log-container')
const connStatus = document.getElementById('conn-status')
const logCount = document.getElementById('log-count')

function render() {
  let visible = logs
  if (activeLevels.size < levels.length)
    visible = visible.filter(e => activeLevels.has(e.level))
  if (searchQuery)
    visible = visible.filter(e => e.message.toLowerCase().includes(searchQuery.toLowerCase()))
  filtered = visible

  const scrollWasAtBottom = autoScroll
  container.innerHTML = visible.map(e => {
    const date = new Date(e.ts)
    const ts = date.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3,'0')
    const msg = escapeHtml(e.message)
    return '<div class="log-line level-' + e.level + '" onclick="toggleExpand(this)"><span class="ts">' + ts + '</span><span class="lvl">' + e.level + '</span><span class="msg">' + msg + '</span></div>'
  }).join('')
  logCount.textContent = logs.length + ' logs' + (filtered.length < logs.length ? ' (' + filtered.length + ' shown)' : '')

  if (scrollWasAtBottom) {
    container.scrollTop = container.scrollHeight
  }
}

function addLog(entry) {
  logs.push(entry)
  if (logs.length > 5000) logs.splice(0, logs.length - 5000)
  if (!paused) render()
}

function toggleExpand(el) {
  el.classList.toggle('expanded')
}

function escapeHtml(s) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

// Level filters
document.getElementById('level-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-level')
  if (!btn) return
  const lvl = btn.dataset.level
  if (activeLevels.has(lvl)) {
    if (activeLevels.size === 1) return
    activeLevels.delete(lvl)
    btn.classList.remove('active')
  } else {
    activeLevels.add(lvl)
    btn.classList.add('active')
  }
  render()
})

// Search
let searchTimer
document.getElementById('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchQuery = e.target.value
    render()
  }, 200)
})

// Pause
document.getElementById('btn-pause').addEventListener('click', () => {
  paused = !paused
  document.getElementById('btn-pause').textContent = paused ? '&#9654;&#65039; Resume' : '&#9654;&#65039; Pause'
  container.classList.toggle('paused', paused)
  if (!paused) render()
})

// Clear
document.getElementById('btn-clear').addEventListener('click', () => {
  logs = []
  render()
})

// Top
document.getElementById('btn-top').addEventListener('click', () => {
  container.scrollTop = 0
})

// Auto-scroll detection
container.addEventListener('scroll', () => {
  const threshold = 50
  autoScroll = (container.scrollHeight - container.scrollTop - container.clientHeight) < threshold
})

// SSE
let es
function connect() {
  const params = new URLSearchParams()
  if (admin) params.set('token', ${JSON.stringify(adminToken)})
  const qs = params.toString()
  es = new EventSource('/logs/stream' + (qs ? '?' + qs : ''))

  es.onopen = () => { connStatus.textContent = '(connected)' }

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === 'init') {
        logs = data.logs
        render()
      } else if (data.type === 'log') {
        addLog(data.entry)
      }
    } catch (e) {}
  }

  es.onerror = () => {
    connStatus.textContent = '(disconnected, retrying...)'
    es.close()
    setTimeout(connect, 3000)
  }
}

connect()
</script>
</body>
</html>`
}
