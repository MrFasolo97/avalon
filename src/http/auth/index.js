const crypto = require('crypto')
const rateLimit = require('express-rate-limit')

const sessions = new Map()

const SESSION_TTL = 24 * 60 * 60 * 1000

setInterval(() => {
    const now = Date.now()
    for (const [sid, data] of sessions)
        if (now - data.ts > SESSION_TTL)
            sessions.delete(sid)
}, 60000)

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    if (a.length !== b.length) return false
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
    } catch {
        return false
    }
}

function getSessionId(req) {
    const cookie = req.headers['cookie'] || ''
    const m = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('auth_session='))
    return m ? m.split('=').slice(1).join('=') : null
}

function getToken(req) {
    const header = req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : ''
    const query = req.query.token || ''
    return header || query
}

function setSessionCookie(res, sid) {
    const secure = res.req && (res.req.secure || res.req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''
    res.set('Set-Cookie', 'auth_session=' + sid + '; Path=/; HttpOnly; SameSite=Strict' + secure)
}

function adminTokens() {
    const vars = ['ADMIN_TOKEN', 'LOG_ADMIN_TOKEN', 'MINE_TOKEN', 'DEBUG_TOKEN', 'RECOVER_TOKEN']
    return vars.map(v => process.env[v]).filter(Boolean)
}

function requireAuth(...tokenEnvVars) {
    return (req, res, next) => {
        const sid = getSessionId(req)
        if (sid && sessions.has(sid)) {
            sessions.get(sid).ts = Date.now()
            return next()
        }

        const token = getToken(req)
        if (token) {
            const candidates = tokenEnvVars.length ? tokenEnvVars.map(v => process.env[v]).filter(Boolean) : adminTokens()
            for (const expected of candidates)
                if (safeEqual(token, expected)) {
                    const newSid = crypto.randomBytes(16).toString('hex')
                    sessions.set(newSid, { ts: Date.now() })
                    setSessionCookie(res, newSid)
                    return next()
                }
        }

        const accept = req.headers['accept'] || ''
        if (accept.includes('text/html') || accept.includes('*/*'))
            res.status(401).set('Content-Type', 'text/html; charset=utf-8').send(renderPopup())
        else
            res.status(401).json({ error: 'authentication required' })
    }
}

function renderPopup() {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Authentication Required</title>\n<style>\n  * { margin: 0; padding: 0; box-sizing: border-box; }\n  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif; display: flex; justify-content: center; padding-top: 80px; min-height: 100vh; }\n  .popup { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px 32px; width: 360px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }\n  .popup h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #f0f6fc; }\n  .popup p { font-size: 13px; color: #8b949e; margin-bottom: 16px; }\n  .popup input { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 14px; outline: none; }\n  .popup input:focus { border-color: #58a6ff; }\n  .popup .error { color: #f85149; font-size: 12px; margin-top: 8px; display: none; }\n  .popup button { margin-top: 16px; width: 100%; padding: 8px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }\n  .popup button:hover { background: #2ea043; }\n  .popup button:disabled { opacity: .6; cursor: default; }\n</style>\n</head>\n<body>\n<div class="popup" id="popup">\n  <h2>&#9670; Authentication Required</h2>\n  <p>Enter the admin code to access this page.</p>\n  <input type="password" id="code" placeholder="Admin code" autocomplete="off" autofocus>\n  <div class="error" id="error"></div>\n  <button id="btn" onclick="submit()">Submit</button>\n</div>\n<script>\nfunction submit() {\n  var btn = document.getElementById(\'btn\');\n  var code = document.getElementById(\'code\').value;\n  if (!code) return;\n  btn.disabled = true; btn.textContent = \'Verifying...\';\n  fetch(\'/auth/login\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify({ code: code }) })\n    .then(function(r) { return r.json().then(function(d) { return { status: r.status, body: d }; }); })\n    .then(function(resp) {\n      if (resp.status === 200) { window.location.reload(); }\n      else {\n        document.getElementById(\'error\').textContent = resp.body.error || \'Invalid code\';\n        document.getElementById(\'error\').style.display = \'block\';\n        btn.disabled = false; btn.textContent = \'Submit\';\n      }\n    })\n    .catch(function() {\n      document.getElementById(\'error\').textContent = \'Network error\';\n      document.getElementById(\'error\').style.display = \'block\';\n      btn.disabled = false; btn.textContent = \'Submit\';\n    });\n}\ndocument.getElementById(\'code\').addEventListener(\'keydown\', function(e) { if (e.key === \'Enter\') submit(); });\n</script>\n</body>\n</html>'
}

module.exports = {
    init: (app) => {
        const authLimiter = rateLimit({
            windowMs: 60000,
            max: 5,
            message: { error: 'too many auth attempts' }
        })
        app.post('/auth/login', authLimiter, (req, res) => {
            const code = req.body && req.body.code
            const tokens = adminTokens()
            if (!code || !tokens.length)
                return res.status(401).json({ error: 'invalid code' })
            let ok = false
            for (const t of tokens)
                if (safeEqual(code, t)) { ok = true; break }
            if (!ok)
                return res.status(401).json({ error: 'invalid code' })
            const sid = crypto.randomBytes(16).toString('hex')
            sessions.set(sid, { ts: Date.now() })
            setSessionCookie(res, sid)
            res.json({ ok: true })
        })
    },
    requireAuth,
    sessions
}
