// setup-jail.js — testnet bootstrap for the offline-leader prototype.
//
// Differences from setup-testnet.js:
//  * MINERS is configurable (4 here: 3 in rotation + 1 standby)
//  * different balances so the rotation order is deterministic (node_appr desc)
//  * leaders vote for THEMSELVES (the master cannot send type 1 txs because
//    masterDaoTxs is left at its mainnet value in this testnet)
const { randomBytes } = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')
const fs = require('fs')
const { execSync } = require('child_process')

const MINERS = parseInt(process.env.MINERS || '4', 10)
const BALANCES = (process.env.MINER_BALANCES || '100000,90000,80000,70000').split(',').map(Number)
const API = 'http://' + (process.env.BOOTSTRAP_HOST || 'localhost') + ':' + (process.env.HTTP_PORT || 3001)
const MASTER = process.env.NODE_OWNER || 'dtube'
const PRIV = process.env.NODE_OWNER_PRIV

function run(cmd) {
    try {
        return execSync(cmd, { cwd: '/avalon', timeout: 60000 }).toString().trim()
    } catch (e) {
        const err = e.stderr ? e.stderr.toString().trim() : e.message
        const redacted = cmd.replace(/-K\s+\S+/g, '-K [REDACTED]')
        console.error('FAILED:', redacted, err)
        return null
    }
}

function cli(args, signKey, signName) {
    signKey = signKey || PRIV
    signName = signName || MASTER
    const out = run(`node src/cli.js ${args} -A ${API} -K ${signKey} -M ${signName}`)
    if (out && out.startsWith('Error:')) return null
    return out
}

function genKeypair() {
    let priv, pub
    do {
        priv = randomBytes(32)
    } while (!secp256k1.privateKeyVerify(priv))
    pub = secp256k1.publicKeyCreate(priv)
    return { priv: bs58.encode(priv), pub: bs58.encode(pub) }
}

function getBlockCount() {
    const raw = run(`curl -sf ${API}/count 2>/dev/null || echo '{"count":0}'`)
    try {
        return parseInt(JSON.parse(raw).count) || 0
    } catch (e) {
        return 0
    }
}

function waitBlocks(n) {
    const target = getBlockCount() + n
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
        if (getBlockCount() >= target) return
        execSync('sleep 2')
    }
    console.error('TIMEOUT: waited 180s for ' + n + ' block(s), giving up')
}

async function main() {
    console.log('\n=== Avalon Jail Testnet Setup ===')
    console.log('API:', API, 'Master:', MASTER, 'Miners:', MINERS, 'Balances:', BALANCES)

    const cfgDir = '/avalon/config/testnet-keys'
    fs.mkdirSync(cfgDir, { recursive: true })

    const miners = []
    for (let i = 1; i <= MINERS; i++) {
        const name = `miner${i}`
        const kp = genKeypair()
        miners.push({ name, ...kp, balance: BALANCES[i - 1] || 70000, ws: `ws://${name}:6001` })
        console.log(`\n  ${name}: pub=${kp.pub.slice(0, 16)}... priv=${kp.priv.slice(0, 8)}... balance=${BALANCES[i - 1] || 70000}`)
    }

    console.log('\n--- Creating accounts ---')
    for (const m of miners) {
        for (let attempt = 0; attempt < 30; attempt++) {
            const r = cli(`account ${m.pub} ${m.name}`)
            if (r) {
                console.log(`  ✓ ${m.name} created`)
                fs.writeFileSync(`${cfgDir}/${m.name}.json`, JSON.stringify(m, null, 2))
                break
            }
            console.log(`  retry ${m.name} (attempt ${attempt})...`)
            waitBlocks(1)
        }
    }

    console.log('\n--- Transferring tokens ---')
    waitBlocks(3)
    for (const m of miners) {
        for (let attempt = 0; attempt < 30; attempt++) {
            const r = cli(`transfer ${m.name} ${m.balance}`)
            if (r) {
                console.log(`  ✓ ${m.name} transfer ${m.balance}`)
                break
            }
            console.log(`  retry ${m.name} transfer (attempt ${attempt})...`)
            waitBlocks(1)
        }
    }

    console.log('\n--- Enabling nodes (waiting for bandwidth to grow) ---')
    waitBlocks(40)
    for (const m of miners) {
        for (let attempt = 0; attempt < 60; attempt++) {
            const r = cli(`enable-node ${m.pub}`, m.priv, m.name)
            if (r) {
                console.log(`  ✓ ${m.name} enabled`)
                fs.writeFileSync(`${cfgDir}/${m.name}.json`, JSON.stringify(m, null, 2))
                break
            }
            console.log(`  retry ${m.name} enable-node (attempt ${attempt})...`)
            waitBlocks(3)
        }
    }

    console.log('\n--- Waiting for miners to connect ---')
    waitBlocks(5)
    run(`curl -sf ${API}/peers 2>/dev/null || echo "no peers yet"`)

    console.log('\n--- Leaders vote for themselves (node_appr = balance) ---')
    for (const m of miners) {
        for (let attempt = 0; attempt < 30; attempt++) {
            const r = cli(`vote-leader ${m.name}`, m.priv, m.name)
            if (r) {
                console.log(`  ✓ ${m.name} self-voted`)
                break
            }
            console.log(`  retry ${m.name} vote-leader (attempt ${attempt})...`)
            waitBlocks(1)
        }
    }

    const env = miners.map(m =>
        `${m.name.toUpperCase()}_PUB=${m.pub}\n${m.name.toUpperCase()}_PRIV=${m.priv}`
    ).join('\n')
    fs.writeFileSync(`${cfgDir}/.env`, env)

    console.log('\n=== Setup Complete ===')
    miners.forEach(m => console.log(`  ${m.name}: PUB=${m.pub} PRIV=${m.priv} BAL=${m.balance}`))
}

main().catch(e => {
    console.error('FATAL:', e)
    process.exit(1)
})
