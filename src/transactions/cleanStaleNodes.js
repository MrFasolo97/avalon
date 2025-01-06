module.exports = {
    fields: ["memo"],
    validate: (tx, ts, legitUser, cb) => {
        try {
            cache.findMany("accounts", { node_appr: { $gt: 0 }}, { node_appr: -1, name: -1 }, (err, leaders) => {
                if (err) throw err;
                for (let leader=0; leader<config.leaders && leader<leaders.length; leader++)
                    if (leaders[leader]._id == tx.sender)
                        cb(true);
                cb(false, "Unauthorized sender");
            });
        } catch(err) {
            logr.debug("Error while validating cleanStaleNodes")
            logr.debug(err)
            cb(false)
            throw err;
        };
    },
    execute: (tx, ts, cb) => {
        try {
            cache.findMany("accounts", { node_appr: { $gt: 0 }}, { node_appr: -1, name: -1 }, (err, leaders) => {
                if (err) throw err
                for (let i=0; i<config.leaders; i++) {
                    try {
                        cache.findOne("leaders", {_id: leaders[i].name}, (err2, leader) => {
                            if (err2) throw err2;
                            if (leader.last < chain.getLatestBlock()._id - config.staleGraceBlocks) {
                                try {
                                    cache.findMany('accounts', { approves: {$in: [leaders[i]]}}, {}, () => {
                                        for (let i in voters) {
                                            cache.findOne('accounts', {name: voters[i].name}, function(err, acc) {
                                                if (err) throw err
                                                if (!acc.approves) acc.approves = []
                                                let node_appr = (acc.approves.length === 0 ? 0 : Math.floor(acc.balance/acc.approves.length))
                                                let node_appr_before = Math.floor(acc.balance/(acc.approves.length+1))
                                                let node_owners = []
                                                for (let i = 0; i < acc.approves.length; i++)
                                                    if (acc.approves[i] !== leaders[i]._id)
                                                        node_owners.push(acc.approves[i])
                                                cache.updateMany('accounts', 
                                                    {name: {$in: node_owners}},
                                                    {$inc: {node_appr: node_appr-node_appr_before}}, function() {
                                                        cache.updateOne('accounts', 
                                                            {name: leader._id},
                                                            {$inc: {node_appr: -node_appr_before}}, function() {
                                                                cb(true)
                                                            }
                                                        )
                                                    })
                                            })
                                        }
                                    });
                                } catch (err4) {
                                    throw err4;
                                }
                            }
                        });
                    } catch(err3) {
                        throw err3;
                    };
                }
            });
        } catch (err1) {
            throw err;
        };
    }
}
