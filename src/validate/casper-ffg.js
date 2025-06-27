const crypto = require('crypto');
const assert = require('assert');


class CasperFFG {
    constructor(validators, checkpointInterval = 50) {
        assert(validators && validators.length > 0, 'Validators array required');
        this.validators = validators;
        // Track validator weights
        this.validatorWeights = new Map();
        this.totalWeight = 0;
        validators.forEach(v => {
            this.validatorWeights.set(v.pubkey, v.weight || 1);
            this.totalWeight += v.weight || 1;
        });
        this.checkpointInterval = checkpointInterval;
        this.currentEpoch = 0;
        this.checkpoints = new Map(); // epoch -> {blockHash, blockNumber}
        this.votes = new Map(); // voteKey -> {validator: count}
        this.justified = new Map(); // blockHash -> epoch
        this.finalized = new Set();
        this.lastFinalizedEpoch = -1;
    }

    // Called when a new checkpoint block is created
    newCheckpoint(blockHash, blockNumber) {
        const epoch = Math.floor(blockNumber / this.checkpointInterval);
        this.checkpoints.set(epoch, {blockHash, blockNumber});
        this.currentEpoch = epoch;
        return this.createVote(epoch, blockHash);
    }

    createVote(epoch, targetHash) {
        assert(this.checkpoints.has(epoch), 'Cannot vote for unknown epoch');
        assert(this.checkpoints.get(epoch).blockHash === targetHash, 'Invalid target hash');
        
        const vote = {
            epoch,
            targetHash,
            validator: this.validators[0], // In real implementation, use actual validator key
            signature: this._signVote(epoch, targetHash)
        };
        
        this._processVote(vote);
        return vote;
    }

    processVote(vote) {
        if (!this._validateVote(vote)) {
            return false;
        }
        
        // Check if vote is for a known checkpoint
        const checkpoint = this.checkpoints.get(vote.epoch);
        if (!checkpoint || checkpoint.blockHash !== vote.targetHash) {
            return false;
        }
        
        this._processVote(vote);
        return true;
    }

    isFinalized(blockHash) {
        return this.finalized.has(blockHash);
    }

    getFinalizedCheckpoint() {
        if (this.finalized.size === 0) return null;
        const latestEpoch = Math.max(...Array.from(this.finalized)
            .map(hash => this.justified.get(hash)));
        return this.checkpoints.get(latestEpoch);
    }

    // Handle chain reorganization
    handleReorg(newHead, chain) {
        // If no checkpoints exist yet, allow reorg
        if (this.checkpoints.size === 0) {
            return true;
        }

        const newHeadEpoch = Math.floor(newHead._id / this.checkpointInterval);
        
        // Find the latest checkpoint that's before or at the new head
        let latestCheckpointBeforeHead = null;
        for (const [epoch, checkpoint] of this.checkpoints) {
            if (epoch <= newHeadEpoch && 
                (!latestCheckpointBeforeHead || epoch > latestCheckpointBeforeHead.epoch)) {
                latestCheckpointBeforeHead = { epoch, ...checkpoint };
            }
        }

        // If no checkpoint exists before the new head, allow reorg
        if (!latestCheckpointBeforeHead) {
            return true;
        }

        // Verify the checkpoint block is in the new chain
        try {
            let current = newHead;
            while (current && current._id > latestCheckpointBeforeHead.blockNumber) {
                current = chain.getBlockByHash(current.phash);
            }

            if (current && current.hash === latestCheckpointBeforeHead.blockHash) {
                return true;
            }
        } catch (e) {
            logr.error('Error during reorg checkpoint validation:', e);
        }

        return false;
    }
    
    async getBlockByHash(hash) {
        try {
            // Check in-memory blocks first
            for (const block of this.recentBlocks) {
                if (block.hash === hash) return block;
            }
            
            // Check blocks storage
            return await blocks.getBlockByHash(hash);
        } catch (e) {
            return null;
        }
    }

    _reprocessVotesForChain(chain) {
        // Clear existing state
        this.justified.clear();
        this.finalized.clear();
        
        // Re-process all votes against the new chain
        for (const [voteKey, count] of this.votes) {
            const [epoch, targetHash] = voteKey.split(':');
            const checkpoint = this.checkpoints.get(parseInt(epoch));
            
            if (checkpoint && checkpoint.blockHash === targetHash) {
                // Verify this block is in the new chain
                try {
                    const block = chain.getBlockByHash(targetHash);
                    if (block) {
                        this._processVote({epoch: parseInt(epoch), targetHash});
                    }
                } catch (e) {
                    // Block not in new chain, vote is invalid
                }
            }
        }
    }

    _processVote(vote) {
        const voteKey = `${vote.epoch}:${vote.targetHash}`;
        const currentCount = this.votes.get(voteKey) || new Set();
        
        if (!currentCount.has(vote.validator)) {
            currentCount.add(vote.validator);
            this.votes.set(voteKey, currentCount);
        }
        
        // Check for supermajority (2/3 of validators)
        if (currentCount.size > (2/3) * this.validators.length) {
            this.justified.set(vote.targetHash, vote.epoch);
            
            // Check for consecutive justified epochs (finalization condition)
            const prevEpoch = vote.epoch - 1;
            const prevCheckpoint = this.checkpoints.get(prevEpoch);
            if (prevCheckpoint && this.justified.has(prevCheckpoint.blockHash)) {
                this.finalized.add(prevCheckpoint.blockHash);
                this.lastFinalizedEpoch = prevEpoch;
                console.log(`Block ${prevCheckpoint.blockHash} (height ${prevCheckpoint.blockNumber}) finalized!`);
            }
        }
    }

    _validateVote(vote) {
        // Verify signature
        const verify = crypto.createVerify('SHA256');
        verify.update(`${vote.epoch}:${vote.targetHash}`);
        return verify.verify(vote.validator, vote.signature);
    }

    _signVote(epoch, targetHash) {
        const sign = crypto.createSign('SHA256');
        sign.update(`${epoch}:${targetHash}`);
        return sign.sign(this.validators[0].privateKey, 'hex');
    }
}

module.exports = CasperFFG;