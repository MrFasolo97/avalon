// s4-patch.js — idempotent testnet config patch (same effect as the inline
// patches in testnet-genesis.sh / testnet-miner.sh): masterDaoTxs for the
// master account + forceFinalize activation at block 100.
const fs = require('fs')
const p = '/avalon/src/config.js'
let c = fs.readFileSync(p, 'utf8')
const before = c
c = c.replace(/masterDaoTxs: \[[^\]]*\]/, 'masterDaoTxs: [0,1,2,3,4,5,6,7,8,10,11,12,13,14,15,17,18,19,20,21,23,24,25,26,27,28,29,30,32]')
if (!c.includes('100: {\n            forceFinalize: true'))
    c = c.replace('241600: {', '100: {\n            forceFinalize: true,\n        },\n        241600: {')
fs.writeFileSync(p, c)
console.log(c === before ? 'Config already patched' : 'Patched testnet config (masterDaoTxs + forceFinalize@100)')
