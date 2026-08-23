const EventEmitter = require('events')
const MAX_LOGS = 1000
const MAX_MESSAGE_LENGTH = 10000

const SECRET_ENV_KEYS = [
    'NODE_OWNER_PRIV',
    'YT_API_KEY',
    'NODE_OWNER',
    'NODE_OWNER_PUB',
    'DB_URL',
    'DB_NAME',
    'ADMIN_TOKEN',
    'LOG_ADMIN_TOKEN',
    'MINE_TOKEN',
    'DEBUG_TOKEN',
    'RECOVER_TOKEN'
]

const IPV4 = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g

const IPV6_BASIC = /(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,7}:|(?:[a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,5}(?::[a-fA-F0-9]{1,4}){1,2}|(?:[a-fA-F0-9]{1,4}:){1,4}(?::[a-fA-F0-9]{1,4}){1,3}|(?:[a-fA-F0-9]{1,4}:){1,3}(?::[a-fA-F0-9]{1,4}){1,4}|(?:[a-fA-F0-9]{1,4}:){1,2}(?::[a-fA-F0-9]{1,4}){1,5}|[a-fA-F0-9]{1,4}:(?:(?::[a-fA-F0-9]{1,4}){1,6})|:(?:(?::[a-fA-F0-9]{1,4}){1,7}|:)/g

const MONGO_CREDS = /(mongodb(?:\+srv)?:\/\/)([^@]+@)/g

const STACK_LINE = /^\s+at\s.*$/gm

const SECRET_PATTERNS = SECRET_ENV_KEYS.map(k => new RegExp(`${k}=[^\\s&"']+`, 'g'))

function sanitizeMessage(msg) {
    if (typeof msg !== 'string') return String(msg)
    if (msg.length > MAX_MESSAGE_LENGTH) msg = msg.slice(0, MAX_MESSAGE_LENGTH) + '...[truncated]'
    msg = msg.replace(MONGO_CREDS, '$1[REDACTED]@')
    msg = msg.replace(IPV4, '[IP]')
    msg = msg.replace(IPV6_BASIC, '[IP]')
    for (const re of SECRET_PATTERNS) msg = msg.replace(re, (m) => m.replace(/=.*/, '=[REDACTED]'))
    msg = msg.replace(STACK_LINE, '    at [stack]')
    return msg
}

function sanitizeMessageFull(msg) {
    if (typeof msg !== 'string') return String(msg)
    if (msg.length > MAX_MESSAGE_LENGTH) msg = msg.slice(0, MAX_MESSAGE_LENGTH) + '...[truncated]'
    msg = msg.replace(MONGO_CREDS, '$1[REDACTED]@')
    for (const re of SECRET_PATTERNS) msg = msg.replace(re, (m) => m.replace(/=.*/, '=[REDACTED]'))
    return msg
}

let buffer = []

const emitter = new EventEmitter()
emitter.setMaxListeners(200)

module.exports = {
    append(rawMessage, level) {
        const ts = Date.now()
        const entry = {
            ts,
            level: level || 'INFO',
            message: sanitizeMessage(rawMessage),
            _raw: typeof rawMessage === 'string' && process.env.LOG_FULL === '1' && process.env.LOG_ADMIN_TOKEN ? sanitizeMessageFull(rawMessage) : undefined
        }
        buffer.push(entry)
        if (buffer.length > MAX_LOGS) buffer.shift()

        try { emitter.emit('log', entry) } catch (e) { /* ignore */ }
    },

    getLogs({ level, search, full } = {}) {
        let result = buffer
        if (level) {
            const levels = Array.isArray(level) ? level : [level]
            result = result.filter(e => levels.includes(e.level))
        }
        if (search) {
            const q = search.toLowerCase()
            result = result.filter(e => e.message.toLowerCase().includes(q))
        }
        if (!full) 
            result = result.map(e => {
                const rest = { ...e }
                delete rest._raw
                return rest
            })
    
        return result
    },

    emitter,

    sanitizeMessage,
    sanitizeMessageFull,

    clear() { buffer = [] }
}
