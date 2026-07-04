let config = require('./config.js').read(0)
const crypto = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')(config.b58Alphabet)
//const bs58 = require('bs58')
let sign = (privKey, sender, tx) => {
    // parsing the tx
    tx = JSON.parse(tx)
    // add timestamp to seed the hash (avoid transactions reuse)
    tx.sender = sender
    tx.ts = new Date().getTime()
    let txString = JSON.stringify(tx)

    // hash the transaction
    tx.hash = crypto.createHash('sha256').update(txString).digest('hex')

    // decode the key
    let rawPriv = bs58.decode(privKey)

    // sign the tx
    let signature = secp256k1.ecdsaSign(Buffer.from(tx.hash, 'hex'), rawPriv)

    // convert signature to base58
    tx.signature = bs58.encode(signature.signature)
    return tx
}

let cmds = {
    sign: (priv, sender, tx) => {
        return sign(priv, sender, tx)
    },

    createAccount: (privKey, sender, pub, name) => {
        let tx = {type: 0, data: {pub, name}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    approveNode: (privKey, sender, nodeName) => {
        let tx = {type: 1, data: {target: nodeName}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    disapproveNode: (privKey, sender, nodeName) => {
        let tx = {type: 2, data: {target: nodeName}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    transfer: (privKey, sender, receiver, amount, memo) => {
        if (!memo) memo=''
        let tx = {type: 3, data: {receiver, amount: parseInt(amount), memo}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    post: (privKey, sender, uri, content) => {
        let tx = {type: 4, data: {link: uri, json: typeof content === 'string' ? JSON.parse(content) : content}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    comment: (privKey, sender, uri, pa, pp, content, weight, tag) => {
        let tx = {type: 4, data: {link: uri, pa, pp, vt: parseInt(weight), tag, json: typeof content === 'string' ? JSON.parse(content) : content}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    vote: (privKey, sender, link, author, weight, tag) => {
        if (!tag) tag = ''
        let tx = {type: 5, data: {link, author, vt: parseInt(weight), tag}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    profile: (privKey, sender, content) => {
        let tx = {type: 6, data: {json: typeof content === 'string' ? JSON.parse(content) : content}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    follow: (privKey, sender, username) => {
        let tx = {type: 7, data: {target: username}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    unfollow: (privKey, sender, username) => {
        let tx = {type: 8, data: {target: username}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    newKey: (privKey, sender, id, pub, types) => {
        let tx = {type: 10, data: {id, pub, types: typeof types === 'string' ? JSON.parse(types) : types}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    removeKey: (privKey, sender, id) => {
        let tx = {type: 11, data: {id}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    changePassword: (privKey, sender, pub) => {
        let tx = {type: 12, data: {pub}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    promotedComment: (privKey, sender, uri, pa, pp, content, weight, tag, burn) => {
        let tx = {type: 13, data: {link: uri, pa, pp, vt: parseInt(weight), tag, burn, json: typeof content === 'string' ? JSON.parse(content) : content}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    transferVt: (privKey, sender, receiver, amount) => {
        let tx = {type: 14, data: {receiver, amount: parseInt(amount)}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    transferBw: (privKey, sender, receiver, amount) => {
        let tx = {type: 15, data: {receiver, amount: parseInt(amount)}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    limitVt: (privKey, sender, amount) => {
        amount = parseInt(amount)
        if (amount === -1) amount = null
        let tx = {type: 16, data: {amount}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    claimReward: (privKey, sender, author, link) => {
        let tx = {type: 17, data: {author, link}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    enableNode: (privKey, sender, pub) => {
        let tx = {type: 18, data: {pub}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    tippedVote: (privkey, sender, link, author, weight, tag, tip) => {
        if (!tag) tag = ''
        let tx = {type: 19, data: {link, author, vt: parseInt(weight), tag, tip: parseInt(tip)}}
        return sign(privkey, sender, JSON.stringify(tx))
    },

    newWeightedKey: (privKey, sender, id, pub, types, weight) => {
        let tx = {type: 20, data: {id, pub, types: typeof types === 'string' ? JSON.parse(types) : types, weight}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    setSignatureThreshold: (privKey, sender, thresholds) => {
        let tx = {type: 21, data: {thresholds: typeof thresholds === 'string' ? JSON.parse(thresholds) : thresholds}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    setPasswordWeight: (privKey, sender, weight) => {
        let tx = {type: 22, data: {weight}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    unsetSignatureThreshold: (privKey, sender, types) => {
        let tx = {type: 23, data: {types: typeof types === 'string' ? JSON.parse(types) : types}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    createAccountWithBw: (privKey, sender, pub, name, bw) => {
        let tx = {type: 24, data: {pub, name, bw: parseInt(bw)}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    playlistJson: (privKey, sender, link, json) => {
        let tx = {type: 25, data: {link, json: typeof json === 'string' ? JSON.parse(json) : json}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    playlistPush: (privKey, sender, link, seq) => {
        let tx = {type: 26, data: {link, seq}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    playlistPop: (privKey, sender, link, seq) => {
        let tx = {type: 27, data: {link, seq}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    commentEdit: (privKey, sender, link, json) => {
        let tx = {type: 28, data: {link, json: typeof json === 'string' ? JSON.parse(json) : json}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    accountAuthorize: (privKey, sender, user, id, types, weight) => {
        let tx = {type: 29, data: {user, id, types: typeof types === 'string' ? JSON.parse(types) : types, weight}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    accountRevoke: (privKey, sender, user, id) => {
        let tx = {type: 30, data: {user, id}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    fundRequestCreate: (privKey, sender, title, description, url, requested, receiver) => {
        let tx = {type: 31, data: {title, description, url, requested, receiver}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    fundRequestContrib: (privKey, sender, id, amount) => {
        let tx = {type: 32, data: {id, amount}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    fundRequestWork: (privKey, sender, id, work) => {
        let tx = {type: 33, data: {id, work: typeof work === 'string' ? JSON.parse(work) : work}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    fundRequestWorkReview: (privKey, sender, id, approve, memo) => {
        let tx = {type: 34, data: {id, approve, memo}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    proposalVote: (privKey, sender, id, amount) => {
        let tx = {type: 35, data: {id, amount}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    proposalEdit: (privKey, sender, id, title, description, url) => {
        let tx = {type: 36, data: {id, title, description, url}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    chainUpdateCreate: (privKey, sender, title, description, url, changes) => {
        let tx = {type: 37, data: {title, description, url, changes: typeof changes === 'string' ? JSON.parse(changes) : changes}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    mdQueue: (privKey, sender, txtype, payload) => {
        let tx = {type: 38, data: {txtype, payload: typeof payload === 'string' ? JSON.parse(payload) : payload}}
        return sign(privKey, sender, JSON.stringify(tx))
    },

    mdSign: (privKey, sender, id) => {
        let tx = {type: 39, data: {id}}
        return sign(privKey, sender, JSON.stringify(tx))
    }
}

module.exports = cmds
