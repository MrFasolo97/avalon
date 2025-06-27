module.exports = {
    fields: ['target'],
    validate: (tx, ts, legitUser, cb) => {
        if (!validate.string(tx.data.target, config.accountMaxLength, config.accountMinLength, config.allowedUsernameChars, config.allowedUsernameCharsOnlyMiddle)) {
            cb(false, 'invalid tx data.target'); 
            return;
        }

        cache.findOne('accounts', {name: tx.sender}, function(err, acc) {
            if (err) throw err;
            
            // Initialize approves array if not exists
            if (!acc.approves) acc.approves = [];
            
            // Check if already voting for this target
            if (acc.approves.includes(tx.data.target)) {
                cb(false, 'invalid tx already voting'); 
                return;
            }
            
            // Check max votes limit
            if (acc.approves.length >= config.leaderMaxVotes) {
                cb(false, 'invalid tx max votes reached');
                return;
            }
            
            // Validate target account
            cache.findOne('accounts', {name: tx.data.target}, function(err, targetAccount) {
                if (err) throw err;
                
                if (!targetAccount) {
                    cb(false, 'invalid tx target does not exist');
                    return;
                }
                
                // Check if target is eligible to be a validator
                if (config.disallowVotingInactiveLeader && !targetAccount.pub_leader) {
                    cb(false, 'target does not have an activated leader signing key');
                    return;
                }
                
                // Additional check for dynamic validator sets
                if (config.casper && config.casper.validators) {
                    const currentValidators = config.casper.validators.map(v => v.name);
                    if (!currentValidators.includes(tx.data.target) && currentValidators.length >= config.maxValidators) {
                        cb(false, 'validator set is full, cannot add new validators');
                        return;
                    }
                }
                
                // All checks passed
                cb(true);
            });
        });
    },
    execute: (tx, ts, cb) => {
        cache.updateOne('accounts', 
            {name: tx.sender},
            {$push: {approves: tx.data.target}},
            function(err) {
                if (err) throw err;
                
                cache.findOne('accounts', {name: tx.sender}, function(err, acc) {
                    if (err) throw err;
                    if (!acc.approves) acc.approves = [];
                    
                    // Calculate new node approval values
                    const nodeCount = acc.approves.length;
                    const node_appr = Math.floor(acc.balance / nodeCount);
                    const node_appr_before = nodeCount === 1 ? 0 : Math.floor(acc.balance / (nodeCount - 1));
                    
                    // Get all node owners except the new one
                    const node_owners = acc.approves.filter(name => name !== tx.data.target);
                    
                    // Update approval values for existing nodes
                    cache.updateMany('accounts', 
                        {name: {$in: node_owners}},
                        {$inc: {node_appr: node_appr - node_appr_before}}, 
                        function(err) {
                            if (err) throw err;
                            
                            // Update approval value for the new node
                            cache.updateOne('accounts', 
                                {name: tx.data.target},
                                {$inc: {node_appr: node_appr}}, 
                                function(err) {
                                    if (err) throw err;
                                    
                                    // Update validator set in Casper FFG if enabled
                                    if (config.casper) {
                                        updateValidatorSet(tx.data.target, node_appr, () => {
                                            cb(true);
                                        });
                                    } else {
                                        cb(true);
                                    }
                                }
                            );
                        }
                    );
                });
            }
        );
    }
};

// Helper function to update Casper FFG validator set
function updateValidatorSet(newValidator, weight, callback) {
    cache.findOne('accounts', {name: newValidator}, (err, account) => {
        if (err || !account || !account.pub_leader) {
            logr.warn('Cannot add validator without leader key:', newValidator);
            return callback();
        }
        
        const newValidatorObj = {
            name: newValidator,
            pubkey: account.pub_leader,
            weight: account.node_appr
        };
        
        // Get current validators
        const currentValidators = config.casper.validators || [];
        
        // Check if validator already exists
        const existingIndex = currentValidators.findIndex(v => v.name === newValidator);
        
        if (existingIndex >= 0) {
            // Update weight if validator exists
            currentValidators[existingIndex].weight = weight;
        } else if (currentValidators.length < config.maxValidators) {
            // Add new validator if under limit
            currentValidators.push(newValidatorObj);
        }
        
        // Sort validators by weight (descending)
        currentValidators.sort((a, b) => b.weight - a.weight);
        
        // Apply changes to Casper FFG
        config.casper.updateValidators(currentValidators);
        
        logr.info('Updated validator set:', currentValidators.map(v => v.name));
        callback();
    });
}