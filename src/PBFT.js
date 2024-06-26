const logger = require('./logger.js')

class PBFT {
    constructor(nodeId, peerId, peers) {
        this.nodeId = nodeId // Unique ID for this node (aka mining leader username)
        this.peerId = peerId // aka p2p.nodeId.pub, changes at each new run.
        this.peers = peers // List of peer node IDs
        this.state = 'Idle' // Current state
        this.messageLog = [] // Log of messages
        this.currentView = 0 // Current view number
        this.viewChangeMsgs = [] 
        this.prePrepareMsgs = {} // Store pre-prepare messages
        this.prepareMsgs = {} // Store prepare messages
        this.commitMsgs = {} // Store commit messages
        this.timeout = null
    }
}

PBFT.prototype.startConsensus = function (transaction) {
    if (this.isPrimary()) {
        const prePrepareMsg = this.createPrePrepareMsg(transaction)
        this.prePrepareMsgs[prePrepareMsg.view] = prePrepareMsg
        p2p.broadcast(prePrepareMsg)
        this.state = 'Pre-Prepare'
        this.startTimeout()
    } else {
        // Send the transaction to the primary
        const primaryNode = this.peers[this.currentView % this.peers.length]
        const primarySocket = p2p.sockets.find(socket => socket.leader_name === primaryNode)
        if (primarySocket)
            primarySocket.send(JSON.stringify({ type: 'NewTransaction', transaction }))
    }
}
  
PBFT.prototype.createPrePrepareMsg = function (transaction) {
    return {
        type: 'PrePrepare',
        view: this.currentView,
        transaction: transaction, // transaction aka new proposed block.ss
        nodeId: this.nodeId
    }
}
  
PBFT.prototype.handlePrePrepare = function (msg) {
    if (this.state === 'Idle' && !this.isPrimary() && msg.view === this.currentView) {
        this.prePrepareMsgs[msg.view] = msg
        const prepareMsg = this.createPrepareMsg(msg)
        p2p.broadcast(prepareMsg)
        this.startTimeout() // Start timeout for pre-prepare phase
        this.state = 'Prepare'
    }
}
  
PBFT.prototype.createPrepareMsg = function (prePrepareMsg) {
    return {
        type: 'Prepare',
        view: prePrepareMsg.view,
        transaction: prePrepareMsg.transaction,
        nodeId: this.nodeId
    }
}
  
PBFT.prototype.handlePrepare = function (msg) {
    if (this.state === 'Pre-Prepare' && msg.view === this.currentView) {
        this.prepareMsgs[msg.view] = this.prepareMsgs[msg.view] || []
        this.prepareMsgs[msg.view].push(msg)
      
        if (this.prepareMsgs[msg.view].length >= this.quorumSize()) {
            const commitMsg = this.createCommitMsg(msg)
            p2p.broadcast(commitMsg)
            this.startTimeout() // Start timeout for prepare phase
            this.state = 'Commit'
        }
    }
}
  
PBFT.prototype.createCommitMsg = function (prepareMsg) {
    return {
        type: 'Commit',
        view: prepareMsg.view,
        transaction: prepareMsg.transaction,
        nodeId: this.nodeId
    }
}
  
PBFT.prototype.handleCommit = function (msg) {
    if (this.state === 'Prepare' && msg.view === this.currentView) {
        this.commitMsgs[msg.view] = this.commitMsgs[msg.view] || []
        this.commitMsgs[msg.view].push(msg)
      
        if (this.commitMsgs[msg.view].length >= this.quorumSize()) {
            // Commit the transaction to the blockchain
            // consensus.possBlocks.push(msg.transaction)
            let txs = [msg.transaction]
            consensus.endRound(0, txs)
            consensus.remoteRoundConfirm(txs)
            consensus.validateAndAddBlock(txs)
            this.clearTimeout() // Clear timeout after successful commit
            this.state = 'Idle'
        }
    }
}

// Handle view change
PBFT.prototype.handleViewChange = function (msg) {
    this.viewChangeMsgs.push(msg)
    if (this.viewChangeMsgs.length >= this.quorumSize()) {
        this.currentView++
        this.viewChangeMsgs = [] // Reset view change messages
        this.state = 'Idle' // Reset state
    }
}

PBFT.prototype.requestViewChange = function() {
    this.currentView = this.currentView+1
    this.viewChangeMsgs = []
    this.state = 'Idle'
    const viewChangeMsg = {
        type: 'ViewChange',
        nodeId: this.nodeId,
        view: this.currentView,
        timestamp: Date.now()
    }
    this.startTimeout()
    p2p.broadcast(viewChangeMsg)
}

PBFT.prototype.addNewPeer = function(nodeId, address) {
    p2p.pbft.peers.push(nodeId)
    p2p.broadcast({ t: 'AddPeer', d: {nodeId: nodeId, address: address }})
}

PBFT.prototype.handleAddPeer = function(msg) {
    const newNodeId = msg.nodeId
    if (!p2p.pbft.peers.includes(newNodeId))
        p2p.pbft.peers.push(newNodeId)
}


PBFT.prototype.quorumSize = function () {
    return Math.floor(this.peers.length / 3) * 2 + 1
}

PBFT.prototype.startTimeout = function() {
    this.clearTimeout() // Clear any existing timeout
    this.timeout = setTimeout(() => {
        logger.warn('BFT timeout, changing view! view # '+this.currentView)
        this.requestViewChange()
    }, 10000) // 10 seconds timeout for this example
}

PBFT.prototype.clearTimeout = function() {
    if (this.timeout) {
        clearTimeout(this.timeout)
        this.timeout = null
    }
}

PBFT.prototype.isPrimary = function () {
    return this.nodeId === this.peers[(this.currentView % this.peers.length)]
}

module.exports = PBFT