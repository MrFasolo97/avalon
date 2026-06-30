// setup-testnet.js - Generates miner keys and initializes testnet accounts
const { randomBytes } = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')
const fs = require('fs')
const { execSync } = require('child_process')

const MINERS = 3
const API = 'http://' + (process.env.BOOTSTRAP_HOST || 'localhost') + ':' + (process.env.HTTP_PORT || 3001)
const MASTER = process.env.NODE_OWNER || 'dtube'
const PRIV = process.env.NODE_OWNER_PRIV

function run(cmd) {
    try {
        return execSync(cmd, { cwd: '/avalon', timeout: 60000 }).toString().trim()
    } catch (e) {
        const err = e.stderr ? e.stderr.toString().trim() : e.message
        console.error('FAILED:', cmd, err)
        return null
    }
}

function cli(args) {
    return run(`node src/cli.js ${args} -A ${API} -K ${PRIV} -M ${MASTER} -W`)
}

function genKeypair() {
    let priv, pub
    do {
        priv = randomBytes(32)
        pub = secp256k1.publicKeyCreate(priv)
    } while (!secp256k1.privateKeyVerify(priv))
    return { priv: bs58.encode(priv), pub: bs58.encode(pub) }
}

function waitBlocks(n) {
    const current = parseInt(run(`curl -sf ${API}/count 2>/dev/null || echo 0`)) || 0
    const target = current + n
    while (true) {
        const h = parseInt(run(`curl -sf ${API}/count 2>/dev/null || echo 0`)) || 0
        if (h >= target) break
        execSync('sleep 2')
    }
}

async function main() {
    console.log('\n=== Testnet Setup ===')
    console.log('API:', API, 'Master:', MASTER)

    const cfgDir = '/avalon/config/testnet-keys'
    fs.mkdirSync(cfgDir, { recursive: true })

    const miners = []

    for (let i = 1; i <= MINERS; i++) {
        const name = `miner${i}`
        const ws = `ws://${name}:6001`
        const kp = genKeypair()
        miners.push({ name, ...kp, ws })
        console.log(`\n  ${name}: pub=${kp.pub.slice(0, 16)}... priv=${kp.priv.slice(0, 8)}...`)
    }

    console.log('\n--- Creating accounts ---')
    for (const m of miners) {
        for (let attempt = 0; attempt < 30; attempt++) {
            const r = cli(`account ${m.pub} ${m.name}`)
            if (r && r.length < 200) {
                console.log(`  ✓ ${m.name} created`)
                break
            }
            console.log(`  retry ${m.name} (block ${attempt})...`)
            waitBlocks(1)
        }
    }

    console.log('\n--- Transferring tokens ---')
    waitBlocks(3)
    for (const m of miners) {
        const r = cli(`transfer ${MASTER} ${m.name} 100000`)
        console.log(`  ${m.name}: ${r ? '✓' : '✗'}`)
    }

    console.log('\n--- Enabling nodes ---')
    waitBlocks(3)
    for (const m of miners) {
        const r = cli(`enable-node ${m.pub}`)
        console.log(`  ${m.name}: ${r ? '✓' : '✗'}`)
        fs.writeFileSync(`${cfgDir}/${m.name}.json`, JSON.stringify(m, null, 2))
    }

    console.log('\n--- Voting for leaders ---')
    waitBlocks(5)
    for (const m of miners) {
        const r = cli(`vote-leader ${m.name}`)
        console.log(`  ${m.name}: ${r ? '✓' : '✗'}`)
    }

    // Write consolidated env
    const env = miners.map(m =>
        `${m.name.toUpperCase()}_PUB=${m.pub}\n${m.name.toUpperCase()}_PRIV=${m.priv}`
    ).join('\n')
    fs.writeFileSync(`${cfgDir}/.env`, env)

    console.log('\n=== Setup Complete ===')
    console.log('Keys written to', cfgDir)
    miners.forEach(m => console.log(`  ${m.name}: PUB=${m.pub} PRIV=${m.priv}`))
}

main().catch(e => {
    console.error('FATAL:', e)
    process.exit(1)
})
