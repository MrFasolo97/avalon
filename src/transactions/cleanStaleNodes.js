module.exports = {
    fields: ["memo"],
    validate: (tx, ts, legitUser, cb) => {
        try {
            cache.findMany("accounts", { node_appr: { $gt: 0 }}, { node_appr: -1, name: -1 }, (err, leaders) => {
                if (err) throw err;
                for (let leader=0; leader<config.leaders && leader<leaders.length; leader++)
                    if (leaders[leader].name == tx.sender)
                        return cb(true);
                return cb(false, "Unauthorized sender");
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
                for (let i=0; i<config.leaders && i<leaders.length; i++) {
                    try {
                        db.collection("leaders").findOne({_id: leaders[i].name}).then((leader2) => {
                            if (leader2.last < chain.getLatestBlock()._id - config.staleGraceBlocks) {
                                logr.warn("Leader", leader2._id, "eligible to be un-voted! Doing so.")
                                try {
                                    let voters = db.collection('accounts').find({ approves: {$in: [leader2._id]}})
                                        voters.forEach(function(voter) {
                                            logr.trace("Cleaning vote from", voter.name, "to", leader2._id)
                                            newApproves = []
                                            for (leader in voter.approves)
                                                if (voter.approves[leader] !== leader2._id)
                                                    newApproves.push(voter.approves[leader])
                                                db.collection('accounts').updateOne({name: voter.name}, {$set: {approves: newApproves}})
					    
                                                if (err) throw err
                                                if (!voter.approves) voter.approves = []
                                                let node_appr = (newApproves.length === 0 ? 0 : Math.floor(voter.balance/newApproves.length))
                                                let node_appr_before = Math.floor(voter.balance/(newApproves.length+1))
                                                let node_owners = []
                                                for (let x = 0; x < voter.approves.length; x++)
                                                    if (voter.approves[x] !== leader2._id)
                                                        node_owners.push(voter.approves[x])
                                                cache.updateMany('accounts', 
                                                    {name: {$in: node_owners}},
                                                    {$inc: {node_appr: node_appr-node_appr_before}}, function() {
                                                        cache.updateOne('accounts', 
                                                            {name: leader2._id},
                                                            {$inc: {node_appr: -node_appr_before}}, function() {
                                                            }
                                                        )
                                                    })
                                            })
                                } catch (err4) {
				    logr.error(err4)
                                    cb(false, err4)
                                    throw err4;
                                }
                            }
                            }).catch((err) => { logr.error(err); throw err });
                    } catch(err3) {
                        logr.error(err3)
                        cb(false, err3)
                        throw err3;
                    };
                }
            });
            cb(true)
        } catch (err1) {
            cb(false, err1)
            throw err1;
        };
    }
}
