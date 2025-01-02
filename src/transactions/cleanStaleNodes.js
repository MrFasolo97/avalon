module.exports = {
    validate: (tx, ts, cb) => {
        db.collection('accounts').find({ node_appr: { $gt: 0 } }, {
            sort: { node_appr: -1 }
        }).limit(config.leaders).toArray(function (err, leaders) {
            if (err) throw err;
            if (leaders.indexOf(tx.sender) == -1) {
                cb(false, "Unauthorized sender");
            } else {
                cb(true);
            }
        })
    },
    execute: (tx, ts, cb) => {
        db.collection('accounts').find({ node_appr: { $gt: 0 } }, {
            sort: { node_appr: -1 }
        }).limit(config.leaders).toArray(function (err, leaders) {
            if (err) throw err;
            for (let i in leaders) {
                db.collection("state").findOne({headBlock: {$gt: 0 }}).then((state) => {
                    db.collection("leaders").find({_id: leaders[i]}).toArray((err, leader) => {
                        if (err) throw err;
                        if (leader.last < state.headBlock - config.staleGraceBlocks) {
                            db.collection('accounts').find({ approves: {$in: [leaders[i]]}},{}).toArray((err, voters) => {
                                if (err) throw err;
                                for (let i in voters) {
                                    cache.findOne('accounts', {name: voters[i].name}, function(err, acc) {
                                        if (err) throw err
                                        if (!acc.approves) acc.approves = []
                                        let node_appr = (acc.approves.length === 0 ? 0 : Math.floor(acc.balance/acc.approves.length))
                                        let node_appr_before = Math.floor(acc.balance/(acc.approves.length+1))
                                        let node_owners = []
                                        for (let i = 0; i < acc.approves.length; i++)
                                            if (acc.approves[i] !== leaders[i].name)
                                                node_owners.push(acc.approves[i])
                                        cache.updateMany('accounts', 
                                            {name: {$in: node_owners}},
                                            {$inc: {node_appr: node_appr-node_appr_before}}, function() {
                                                cache.updateOne('accounts', 
                                                    {name: tx.data.target},
                                                    {$inc: {node_appr: -node_appr_before}}, function() {
                                                        cb(true)
                                                    }
                                                )
                                            })
                                    })
                                }
                            })         
                        }
                    })
                });
            }
        })
    }
}