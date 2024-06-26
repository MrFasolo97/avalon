const logger = require('./logger.js')

class PBFT {
    constructor(peerId, peers) {
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
        return this.peerId === this.peers[(this.currentView % this.peers.length)]
    }
  
    startConsensus(transaction) {
        logger.trace('Starting "startConsensus()"')
        if (this.isPrimary()) {
            const prePrepareMsg = this.createPrePrepareMsg(transaction)
            this.prePrepareMsgs[prePrepareMsg.view] = prePrepareMsg
            p2p.broadcast(prePrepareMsg)
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
            nodeId: this.peerId,
            timestamp: Date.now()
        }
    }
  
    handlePrePrepare(msg) {
        logger.trace('Starting "handlePrePrepare()"')
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
            nodeId: this.peerId,
            timestamp: Date.now()
        }
    }
  
    handlePrepare(msg) {
        logger.trace('Starting "handlePrepare()"')
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
            nodeId: this.peerId,
            timestamp: Date.now()
        }
    }
  
    handleCommit(msg) {
        logger.trace('Starting "handleCommit()"')
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
        logger.trace('Starting "commitTransaction()"')
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
            nodeId: this.peerId,
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
        this.peers[this.peers.length] = msg.peerId
    }

    addNewPeer(newPeerId) {
        this.peers[this.peers.length] = newPeerId
        p2p.broadcast({ type: 'AddPeer', peerId: newPeerId, address: address })
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