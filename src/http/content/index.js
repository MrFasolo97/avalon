const parallel = require('run-parallel')

module.exports = {
    init: (app) => {
        // get content by tag with limit by certain author
        // filter = author,tag,limit,ts(from, to)
        app.get('/content/:filter', (req, res) => {
            var filterParam = req.params.filter
            var filter = filterParam.split(',')
            if (filter.length == 1) {
                author = filter[0]
                db.collection('contents').find({
                    author: author
                }, { sort: {ts:-1} }).toArray(function (err, contents) {
                    res.send(contents)
                })
            } else if (filter.length == 2) {
                author = filter[0]
                tag = filter[1]
                if (author == "all" && tag != "all") {
                    db.collection('contents').find({
                        'json.tag': tag
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag != "all") {
                    db.collection('contents').find({
                        $and: [
                            { author: author },
                            { 'json.tag': tag }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag == "all") {
                    db.collection('contents').find({
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag == "all") {
                    db.collection('contents').find({
                        author: author,
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            } else if (filter.length == 3) {
                author = filter[0]
                tag = filter[1]
                limit = parseInt(filter[2])

                if (author != "all" && tag != "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: author },
                            { 'json.tag': tag }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag != "all" && limit != -1) {
                    db.collection('contents').find({
                        'json.tag': tag
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag == "all" && limit != -1) {
                    db.collection('contents').find({
                        author: author
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag == "all" && limit != -1) {
                    db.collection('contents').find({
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag != "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: author },
                            { 'json.tag': tag }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag != "all" && limit == -1) {
                    db.collection('contents').find({
                        'json.tag': tag
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag == "all" && limit == -1) {
                    db.collection('contents').find({
                        author: author
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag == "all" && limit == -1) {
                    db.collection('contents').find({
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            } else if (filter.length == 4) {
                author = filter[0]
                tag = filter[1]
                limit = parseInt(filter[2])
                tsrange = filter[3].split(":")
                if (tsrange.length == 2) {
                    tsfrom = parseInt(tsrange[0]) * 1000
                    tsto = parseInt(tsrange[1]) * 1000
                } else {
                    return
                }

                if (author != "all" && tag != "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: author },
                            { 'json.tag': tag },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag != "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { 'json.tag': tag },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag == "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: author },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag == "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag != "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: author },
                            { 'json.tag': tag },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag != "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { 'json.tag': tag },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author != "all" && tag == "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: author },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (author == "all" && tag == "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            }
        })
        // get new contents
        app.get('/content/:author/:link', (req, res) => {
            if (!req.params.author || typeof req.params.link !== 'string') {
                res.sendStatus(500)
                return
            }
            db.collection('contents').findOne({
                author: req.params.author,
                link: req.params.link
            }, function (err, post) {
                if (!post) {
                    res.sendStatus(404)
                    return
                }
                if (!post.child || post.child.length === 0) {
                    res.send(post)
                    return
                }
                post.comments = {}
                function fillComments(posts, cb) {
                    if (!posts || posts.length === 0) {
                        cb()
                        return
                    }
                    var executions = []
                    for (let i = 0; i < posts.length; i++)
                        executions.push(function (callback) {
                            db.collection('contents').find({
                                pa: posts[i].author,
                                pp: posts[i].link
                            }).toArray(function (err, comments) {
                                for (let y = 0; y < comments.length; y++)
                                    post.comments[comments[y].author + '/' + comments[y].link] = comments[y]
                                fillComments(comments, function () {
                                    callback(null, true)
                                })
                            })
                            i++
                        })

                    parallel(executions, function (err, results) {
                        if (err) throw err
                        cb(null, results)
                    })
                }
                fillComments([post], function () {
                    res.send(post)
                })
            })
        })
    }
}
