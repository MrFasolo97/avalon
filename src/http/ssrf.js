const dns = require('dns/promises')
const net = require('net')

const DNS_TIMEOUT = 5000

// Expands any IPv6 notation (including embedded IPv4 and zone ids) to the full
// 8-group form. Returns null when the input is not a valid IPv6 address.
function expandIPv6(ip) {
    let s = String(ip).toLowerCase().split('%')[0].split('/')[0]
    if (!s.includes(':'))
        return null

    // Convert a trailing dotted-quad into the two hex groups it represents
    const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (v4) {
        const p = v4[1].split('.').map(Number)
        if (p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null
        s = s.slice(0, s.length - v4[1].length)
            + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
    }

    const halves = s.split('::')
    if (halves.length > 2) return null

    const head = halves[0] ? halves[0].split(':') : []
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []

    const groups = halves.length === 1
        ? head
        : head.concat(new Array(8 - head.length - tail.length).fill('0'), tail)

    if (groups.length !== 8) return null
    const out = []
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null
        out.push(g.padStart(4, '0'))
    }
    return out
}

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255))
        return true
    const a = parts[0]
    const b = parts[1]
    if (a === 0) return true                              // 0.0.0.0/8
    if (a === 10) return true                             // 10.0.0.0/8
    if (a === 127) return true                            // 127.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true     // 100.64.0.0/10 CGNAT
    if (a === 169 && b === 254) return true               // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true      // 172.16.0.0/12
    if (a === 192 && b === 0 && parts[2] === 0) return true
    if (a === 192 && b === 168) return true               // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true  // 198.18.0.0/15 benchmark
    if (a >= 224) return true                             // multicast, reserved, broadcast
    return false
}

function isPrivateIPv6(ip) {
    const g = expandIPv6(ip)
    if (!g) return true
    const n = i => parseInt(g[i], 16)

    // IPv4-mapped (::ffff:a.b.c.d, groups 0-4 == 0 and group 5 == 0xffff) and
    // IPv4-compatible (::a.b.c.d, groups 0-5 == 0) forms carry a routable IPv4
    // address in the low 32 bits — these must go through the IPv4 checks or they
    // become a trivial bypass of every private-range rule.
    const zeroHigh = n(0) === 0 && n(1) === 0 && n(2) === 0 && n(3) === 0
    if (zeroHigh && n(4) === 0) {
        if (n(5) !== 0 && n(5) !== 0xffff) return false   // not a mapped/compat form
        const embedded = [n(6) >> 8, n(6) & 0xff, n(7) >> 8, n(7) & 0xff].join('.')
        return isPrivateIPv4(embedded)                      // :: and ::1 fall here as 0.0.0.0/0.0.0.1
    }

    if ((n(0) & 0xfe00) === 0xfc00) return true            // fc00::/7 unique local
    if ((n(0) & 0xffc0) === 0xfe80) return true            // fe80::/10 link-local
    if ((n(0) & 0xff00) === 0xff00) return true            // ff00::/8 multicast
    if (n(0) === 0x0064 && n(1) === 0xff9b) return true    // 64:ff9b::/96 NAT64
    if (n(0) === 0x2001 && n(1) === 0x0db8) return true    // 2001:db8::/32 documentation
    if (n(0) === 0x2001 && (n(1) & 0xfff0) === 0x0000) return true // 2001::/32 Teredo
    return false
}

function isPrivateIP(ip) {
    if (net.isIPv4(ip)) return isPrivateIPv4(ip)
    if (net.isIPv6(ip)) return isPrivateIPv6(ip)
    return true
}

async function isPrivateURL(urlStr) {
    try {
        const parsed = new URL(urlStr)
        if (!/^https?:$/.test(parsed.protocol)) return true
        const host = parsed.hostname.replace(/^\[|\]$/g, '')
        if (!host) return true
        if (host === 'localhost' || host === '0.0.0.0' || host === '::') return true

        let ip
        if (net.isIP(host))
            ip = host
        else
            try {
                ip = (await dns.lookup(host, { family: 4 })).address
            } catch {
                return true
            }

        if (!ip) return true
        return isPrivateIP(ip)
    } catch {
        return true
    }
}

async function resolveAndPin(host) {
    if (net.isIP(host)) return host
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), DNS_TIMEOUT)
        try {
            return (await dns.lookup(host, { family: 4, signal: controller.signal })).address
        } finally {
            clearTimeout(timeout)
        }
    } catch {
        return null
    }
}

async function checkRebinding(host, pinnedIp) {
    if (net.isIP(host)) return pinnedIp === host
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), DNS_TIMEOUT)
        try {
            return (await dns.lookup(host, { family: 4, signal: controller.signal })).address === pinnedIp
        } finally {
            clearTimeout(timeout)
        }
    } catch {
        return false
    }
}

async function resolveSafeUrl(urlStr) {
    const maxRedirects = 5
    let currentUrl = urlStr
    for (let i = 0; i < maxRedirects; i++) {
        if (await isPrivateURL(currentUrl))
            throw new Error('blocked private URL')
        const parsed = new URL(currentUrl)
        const pinnedIp = await resolveAndPin(parsed.hostname)
        if (!pinnedIp) throw new Error('could not resolve host')
        if (isPrivateIP(pinnedIp)) throw new Error('blocked private URL')
        if (!(await checkRebinding(parsed.hostname, pinnedIp))) throw new Error('dns rebinding detected')
        parsed.hostname = pinnedIp.includes(':') ? '[' + pinnedIp + ']' : pinnedIp
        currentUrl = parsed.toString()
    }
    throw new Error('too many redirects')
}

module.exports = {
    isPrivateURL,
    isPrivateIP,
    expandIPv6,
    resolveAndPin,
    checkRebinding,
    resolveSafeUrl,
    DNS_TIMEOUT
}
