#!/usr/bin/env node
// == Heartbeat — wake a soft-jailed leader (plan §7.2 / §7.3) ==
//
// Re-sends ENABLE_NODE (type 18) with the account's CURRENT leader key. On
// chain it is idempotent: the same `pub_leader` is $set again, no fee, no
// balance change, no node_appr change, no new transaction type. New nodes clear
// the account's jail when they see the tx inside a finalised block
// (leaderHealth heartbeat rule); old nodes execute it exactly as today.
//
// The operator only needs this for the fast path: the jail also expires on its
// own after `jailBlocks`, so a node that lost its key can simply wait.
//
// Usage:
//   node scripts/heartbeat.js -M alice -K <private_key>
//   node scripts/heartbeat.js -M alice -F alice_key.json -A http://localhost:3001
//   node scripts/heartbeat.js -M alice -K <private_key> --pub <pub_leader>   # skip lookup
//
// Options:
//   -M, --me, --account <name>   account to wake
//   -K, --key <priv>             plain-text private key
//   -F, --file <path>            file holding the key ({"priv":"..."} or raw)
//   -A, --api <url>              node API url (default from API_* env, else :3001)
//   -W, --wait                   wait for on-chain confirmation
//       --pub <pub_leader>       use this leader key instead of the on-chain one

const fs = require('fs')
const fetch = require('node-fetch-commonjs')
const cmds = require('../src/clicmds.js')

function fail(msg) {
    process.stderr.write('heartbeat: ' + msg + '\n')
    process.exit(1)
}

function arg(...flags) {
    for (const flag of flags) {
        const i = process.argv.indexOf(flag)
        if (i !== -1 && i + 1 < process.argv.length)
            return process.argv[i + 1]
    }
    return undefined
}

const has = (...flags) => flags.some(f => process.argv.includes(f))

const account = arg('-M', '--me', '--account')
let key = arg('-K', '--key')
const keyFile = arg('-F', '--file')
let pub = arg('--pub')
const wait = has('-W', '--wait')

if (!account) fail('missing account (-M <name>)')
if (keyFile) {
    try {
        const raw = fs.readFileSync(keyFile, 'utf8')
        try { key = JSON.parse(raw).priv } catch (e) { key = raw.trim() }
    } catch (e) { fail('cannot read key file ' + keyFile + ': ' + e.message) }
}
if (!key) fail('missing key (-K <priv> or -F <file>)')

const port = process.env.API_PORT || 3001
const ip = process.env.API_IP || '[::1]'
const protocol = process.env.API_PROTOCOL || 'http'
const api = arg('-A', '--api') || (protocol + '://' + ip + ':' + port)

async function main() {
    if (!pub) {
        const res = await fetch(api + '/accounts/' + encodeURIComponent(account))
        const accounts = await res.json()
        if (!Array.isArray(accounts) || accounts.length === 0) fail('account "' + account + '" not found on ' + api)
        pub = accounts[0].pub_leader
        if (!pub) fail('account "' + account + '" has no leader key — enable the node first (enable-node)')
        process.stdout.write('Using current leader key ' + pub + '\n')
    }

    const tx = cmds.enableNode(key, account, pub)
    const res = await fetch(api + '/transact' + (wait ? 'WaitConfirm' : ''), {
        method: 'post',
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(tx)
    })
    const body = await res.json()
    if (body && body.error) fail('transaction rejected: ' + body.error)
    process.stdout.write((typeof body === 'string' ? body : JSON.stringify(body)) + '\n')
}

main().catch(e => fail(e.message))
