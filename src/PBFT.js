const logger = require('./logger.js')

class PBFT {
    constructor(nodeId, peerId, peers) {
        this.nodeId = nodeId // Unique ID for this node
        this.peers = peers ? peers : [] // List of peer node IDs
        this.peerId = peerId
        this.state = 'Idle' // Current state
        this.messageLog = [] // Log of messages
        this.currentView = 0 // Current view number
        this.viewChangeMsgs = [] // Store view change messages
        this.prePrepareMsgs = {} // Store pre-prepare messages
        this.prepareMsgs = {} // Store prepare messages
        this.commitMsgs = {} // Store commit messages
        this.timeout = null // Timeout handler
        this.pendingTransactions = [] // Queue of pending transactions
    }
  
    isPrimary () {
        return this.nodeId === this.peers[(this.currentView % this.peers.length)]
    }
  
    startConsensus(transaction) {
        if (this.isPrimary()) {
            const prePrepareMsg = this.createPrePrepareMsg(transaction)
            this.prePrepareMsgs[prePrepareMsg.view] = prePrepareMsg
            this.sendToAllPeers(prePrepareMsg)
            this.state = 'Pre-Prepare'
            this.startTimeout() // Start timeout for consensus
        } else {
        // If not the primary, queue the transaction
            this.pendingTransactions.push(transaction)
        }
    }
  
    createPrePrepareMsg(transaction) {
        return {
            type: 'PrePrepare',
            view: this.currentView,
            transaction: transaction,
            nodeId: this.nodeId,
            timestamp: Date.now()
        }
    }
  
    handlePrePrepare(msg) {
        if (this.state === 'Idle' && !this.isPrimary() && msg.view === this.currentView) {
            this.prePrepareMsgs[msg.view] = msg
            const prepareMsg = this.createPrepareMsg(msg)
            this.sendToAllPeers(prepareMsg)
            this.state = 'Prepare'
            this.startTimeout() // Start timeout for prepare phase
        } else {
        // Invalid PrePrepare message
            this.requestViewChange()
        }
    }
  
    createPrepareMsg(prePrepareMsg) {
        return {
            type: 'Prepare',
            view: prePrepareMsg.view,
            transaction: prePrepareMsg.transaction,
            nodeId: this.nodeId,
            timestamp: Date.now()
        }
    }
  
    handlePrepare(msg) {
        if (this.state === 'Pre-Prepare' && msg.view === this.currentView) {
            this.prepareMsgs[msg.view] = this.prepareMsgs[msg.view] || []
            this.prepareMsgs[msg.view].push(msg)
  
            if (this.prepareMsgs[msg.view].length >= this.quorumSize()) {
                const commitMsg = this.createCommitMsg(msg)
                this.sendToAllPeers(commitMsg)
                this.state = 'Commit'
                this.startTimeout() // Start timeout for commit phase
            }
        } else {
        // Invalid Prepare message
            this.requestViewChange()
        }
    }
  
    createCommitMsg(prepareMsg) {
        return {
            type: 'Commit',
            view: prepareMsg.view,
            transaction: prepareMsg.transaction,
            nodeId: this.nodeId,
            timestamp: Date.now()
        }
    }
  
    handleCommit(msg) {
        if (this.state === 'Prepare' && msg.view === this.currentView) {
            this.commitMsgs[msg.view] = this.commitMsgs[msg.view] || []
            this.commitMsgs[msg.view].push(msg)
  
            if (this.commitMsgs[msg.view].length >= this.quorumSize()) {
                // Commit the transaction to the blockchain
                this.commitTransaction(msg.transaction)
                this.state = 'Idle'
                this.clearTimeout() // Clear timeout after successful commit
  
                // Check if there are pending transactions and start consensus
                if (this.pendingTransactions.length > 0) {
                    const nextTransaction = this.pendingTransactions.shift()
                    this.startConsensus(nextTransaction)
                }
            }
        } else {
        // Invalid Commit message
            this.requestViewChange()
        }
    }
  
    commitTransaction(transaction) {
        // Add transaction to the blockchain
        logger.debug('Transaction committed:', transaction)
        // Reset state and prepare for the next consensus round
        this.state = 'Idle'
    }
  
    quorumSize() {
        return Math.floor(this.peers.length / 3) * 2 + 1
    }
  
    requestViewChange() {
        logger.warn('Requesting view change...')
        this.currentView++
        this.viewChangeMsgs = [] // Reset view change messages
        this.state = 'Idle' // Reset state
        this.sendToAllPeers({
            type: 'ViewChange',
            nodeId: this.nodeId,
            view: this.currentView,
            timestamp: Date.now()
        })
        this.startTimeout() // Start timeout for view change
    }
  
    handleViewChange(msg) {
        this.viewChangeMsgs.push(msg)
        if (this.viewChangeMsgs.length >= this.quorumSize()) {
            this.currentView++
            this.viewChangeMsgs = [] // Reset view change messages
            this.state = 'Idle' // Reset state
  
            // Start consensus for any pending transactions
            if (this.pendingTransactions.length > 0) {
                const nextTransaction = this.pendingTransactions.shift()
                this.startConsensus(nextTransaction)
            }
        }
    }

    handleAddPeer(msg) {
        p2p.pbft.peers.push(msg.peerId)
        p2p.connect([msg.address.indexOf('ws://') === -1 ? 'ws://'+msg.address : msg.address])
    }

    addNewPeer(newPeerId, address) {
        p2p.pbft.push(newPeerId)
        this.sendToAllPeers({ type: 'AddPeer', peerId: newPeerId, address: address })
    }
  
    startTimeout() {
        this.clearTimeout() // Clear any existing timeout
        this.timeout = setTimeout(() => {
            this.requestViewChange()
        }, 10000) // 10 seconds timeout for this example
    }
  
    clearTimeout() {
        if (this.timeout) {
            clearTimeout(this.timeout)
            this.timeout = null
        }
    }

}


module.exports = PBFT