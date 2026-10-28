// s4-fake-txs.js — realistic fake activity for the S4 migration dry run.
//   docker compose run --rm setup node /avalon/scripts/s4-fake-txs.js          (pre-migration)
//   docker compose run --rm setup node /avalon/scripts/s4-fake-txs.js --post   (post-migration)
// User keys are persisted in the testnet_config volume (s4users.json) so the
// same accounts keep acting after the code switch. The pre-migration run also
// creates and funds the passive balance canaries s4alice/s4bob/s4carol
// (balance=20000); they must keep that balance across the migration.
const { execFileSync } = require('child_process')
const { randomBytes } = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')
const fs = require('fs')

const API = 'http://' + (process.env.BOOTSTRAP_HOST || 'localhost') + ':' + (process.env.HTTP_PORT || 3001)
const MASTER = process.env.NODE_OWNER || 'dtube'
const MPRIV = process.env.NODE_OWNER_PRIV
const KEYDIR = '/avalon/config/testnet-keys'
const USERS_FILE = KEYDIR + '/s4users.json'
const POST = process.argv.includes('--post')

function cli(args, priv, name) {
    try {
        const out = execFileSync('node', ['src/cli.js', ...args, '-A', API, '-K', priv, '-M', name],
            { cwd: '/avalon', timeout: 30000, encoding: 'utf8' }).trim()
        if (out.startsWith('Error')) { console.log('    -> ' + out); return false }
        return true
    } catch (e) { console.log('    -> ' + ((e.stdout || '') + ' ' + (e.stderr || '')).trim().slice(0, 300)); return false }
}
function height() {
    try { return JSON.parse(execFileSync('curl', ['-sf', API + '/count'], { encoding: 'utf8' })).count }
    catch (e) { return 0 }
}
function waitBlocks(n) {
    const t = height() + n, dl = Date.now() + 180000
    while (height() < t && Date.now() < dl) execFileSync('sleep', ['1'])
}
function tryTx(label, args, priv, name, attempts) {
    for (let i = 0; i < (attempts || 5); i++) {
        if (cli(args, priv, name)) { console.log('  ✓', label, '(h=' + height() + ')'); waitBlocks(1); return true }
        waitBlocks(2)
    }
    console.log('  ✗ FAILED', label, '(h=' + height() + ')')
    return false
}
function keypair() {
    let p
    do { p = randomBytes(32) } while (!secp256k1.privateKeyVerify(p))
    return { priv: bs58.encode(p), pub: bs58.encode(secp256k1.publicKeyCreate(p)) }
}
function accountExists(n) {
    try { execFileSync('curl', ['-sf', '-o', '/dev/null', API + '/account/' + n], {}); return true }
    catch (e) { return false }
}
function envVal(k) {
    const m = fs.readFileSync(KEYDIR + '/.env', 'utf8').match(new RegExp('^' + k + '=(\\S+)$', 'm'))
    return m && m[1]
}
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch (e) { return {} }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 1)) }

const VIDEO_JSON = JSON.stringify({
    title: 'S4 migration dry-run',
    description: 'Fake post produced while rehearsing the no-econs migration on the local testnet.',
    video: { ipfs: ['QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'], provider: 'IPFS' },
    tags: ['dtube', 'testnet']
})

function ensureUsers(users) {
    // candidates in order; skip names that exist without a saved key (round-1 orphans)
    const candidates = ['s4dave', 's4erin', 's4frank']
    const actors = Object.keys(users).length >= 3 ? Object.keys(users) : []
    for (const c of candidates) {
        if (actors.length >= 3) break
        if (users[c]) { actors.push(c); continue }
        if (accountExists(c)) { console.log('  (skip ' + c + ': exists, key not saved)'); continue }
        users[c] = keypair()
        if (tryTx('account ' + c, ['account', users[c].pub, c], MPRIV, MASTER)) actors.push(c)
        saveUsers(users)
    }
    return actors.slice(0, 3)
}

function ensureCanaries() {
    // passive balance canaries: keys are throwaway (like the original round-1
    // accounts). Created+funded only in the pre-migration run so criterion #4
    // can check that their balance survives the code switch.
    for (const c of ['s4alice', 's4bob', 's4carol']) {
        if (accountExists(c)) { console.log('  (canary ' + c + ' already exists)'); continue }
        const kp = keypair()
        if (tryTx('account ' + c + ' (canary)', ['account', kp.pub, c], MPRIV, MASTER))
            tryTx('transfer 20000 -> ' + c + ' (canary)', ['transfer', c, '20000'], MPRIV, MASTER)
    }
}

async function main() {
    console.log('=== S4 fake txs ===', POST ? '(post-migration mode)' : '(pre-migration mode)', 'API:', API, 'h=' + height())
    const users = loadUsers()
    const miner1 = envVal('MINER1_PRIV'), miner2 = envVal('MINER2_PRIV')

    if (!POST) {
        console.log('--- balance canaries (s4alice/s4bob/s4carol, 20000 each) ---')
        ensureCanaries()

        console.log('--- ensuring actor accounts (master) ---')
        const actors = ensureUsers(users)   // [a, b, c]
        const [a, b, c] = actors
        if (!a) { console.log('FATAL: no actors'); process.exit(1) }

        console.log('--- grants: 1,000,000 each (bwGrowth is +10 bytes/h per DTC) ---')
        for (const n of actors)
            tryTx('transfer 1000000 -> ' + n, ['transfer', n, '1000000'], MPRIV, MASTER)
        console.log('--- waiting 20 blocks for bandwidth to accumulate ---')
        waitBlocks(20)

        console.log('--- posts / reply ---')
        tryTx('master post s4-main-post', ['comment', 's4-main-post', '', '', VIDEO_JSON, '5', 'dtube'], MPRIV, MASTER)
        tryTx(a + ' post s4-' + a.replace('s4', '') + '-post', ['comment', 's4-' + a.slice(2) + '-post', '', '', VIDEO_JSON, '1', 'dtube'], users[a].priv, a)
        tryTx(b + ' reply', ['comment', 's4-reply-' + b.slice(2), a, 's4-' + a.slice(2) + '-post', JSON.stringify({ body: 'Nice first post, ' + a + '!' }), '1', 'dtube'], users[b].priv, b)

        console.log('--- votes ---')
        tryTx(c + ' votes master post', ['vote', 's4-main-post', 'dtube', '2', 'dtube'], users[c].priv, c)
        if (miner2) tryTx('miner2 votes ' + a + ' post', ['vote', 's4-' + a.slice(2) + '-post', a, '1', 'dtube'], miner2, 'miner2')
        if (miner1) tryTx('miner1 tipped-vote master post', ['tipped-vote', 's4-main-post', 'dtube', '1', 'dtube', '10'], miner1, 'miner1')

        console.log('--- user transfer + profile ---')
        tryTx(a + ' -> ' + b + ' 123', ['transfer', b, '123'], users[a].priv, a)
        tryTx(a + ' profile', ['profile', JSON.stringify({ about: 's4 test user', pic: 'https://example.com/pic.png' })], users[a].priv, a)

        console.log('--- negative test: commentEdit must be rejected (txLimits 23/24) ---')
        tryTx('master comment-edit (expected disabled)', ['comment-edit', 's4-main-post', '{"title":"edited"}'], MPRIV, MASTER, 1)
    } else {
        const actors = Object.keys(loadUsers())
        const [a, b, c] = actors
        console.log('--- post-migration activity (new validators live) ---')
        ensureUsers(users)   // may add a 4th user via the NEW create-account path
        const u2 = loadUsers()
        const [x, y] = Object.keys(u2).slice(-2)

        // exercise the NEW create-account path (hardening added a bandwidth check)
        if (!u2.s4gina && !accountExists('s4gina')) {
            const kp = keypair()
            if (tryTx('account s4gina (new-code create-account path)', ['account', kp.pub, 's4gina'], MPRIV, MASTER)) {
                u2.s4gina = kp; saveUsers(u2)
                tryTx('transfer 100000 -> s4gina', ['transfer', 's4gina', '100000'], MPRIV, MASTER)
            }
        }

        tryTx('master post s4-post-migration', ['comment', 's4-post-migration', '', '', VIDEO_JSON, '3', 'dtube'], MPRIV, MASTER)
        tryTx(x + ' votes it', ['vote', 's4-post-migration', 'dtube', '1', 'dtube'], u2[x].priv, x)
        if (a && b) tryTx(a + ' -> ' + b + ' 50', ['transfer', b, '50'], u2[a] ? u2[a].priv : null, a)
        if (a) tryTx(a + ' profile edit', ['profile', JSON.stringify({ about: 's4 test user (post-migration)', pic: 'https://example.com/pic.png' })], u2[a].priv, a)
        console.log('--- negative test parity: commentEdit still disabled under new code ---')
        tryTx('master comment-edit (expected disabled)', ['comment-edit', 's4-main-post', '{"title":"edited"}'], MPRIV, MASTER, 1)
    }

    console.log('--- final state ---')
    const roster = [MASTER, 'miner1', 'miner2', 's4alice', 's4bob', 's4carol', ...Object.keys(loadUsers())]
    for (const n of [...new Set(roster)]) {
        try {
            const a = JSON.parse(execFileSync('curl', ['-sf', API + '/account/' + n], { encoding: 'utf8' }))
            console.log('  ' + n + ': balance=' + a.balance + ' bw=' + JSON.stringify(a.bw) + ' keys=' + (a.keys || []).length)
        } catch (e) { console.log('  ' + n + ': <unavailable>') }
    }
    console.log('=== done, height ' + height() + ' ===')
}
main().catch(e => { console.error('FATAL:', e); process.exit(1) })
