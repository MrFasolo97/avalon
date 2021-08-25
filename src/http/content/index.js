const parallel = require('run-parallel')

module.exports = {
    init: (app) => {
        // get content by tag with limit by certain author
        // filter = author,tag,limit,ts(from, to)
        // $API_URL/filter?author=author1,author2,...,authorN&tag=tag1,tag2,...,tagN&limit=x&ts=tsfrom-tsto
        app.get('/content/:filter', (req, res) => {
            var filterParam = req.params.filter
            var filter = filterParam.split(':')
            var filterBy = filter[1]
            var filterAttrs = filterBy.split('&')

            if (filterAttrs.length == 1) {
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")
                db.collection('contents').find({
                    author: { $in : authors }
                }, { sort: {ts:-1} }).toArray(function (err, contents) {
                    res.send(contents)
                })
            } else if (filterAttrs.length == 2) {
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")
                tags = filterAttrs[1].split('=')[1]
                tags = tags.split(",")
                if (authors[0] == "all" && tags[0]!= "all") {
                    db.collection('contents').find({
                        'json.tag': { $in: tags }
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all" && tags[0] != "all") {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors } },
                            { 'json.tag': { $in: tags } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] == "all" && tags[0] == "all") {
                    db.collection('contents').find({
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all"  && tags[0] == "all") {
                    db.collection('contents').find({
                        author: { $in : authors },
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            } else if (filterAttrs.length == 3) {
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")
                tags = filterAttrs[1].split('=')[1]
                tags = tags.split(",")
                limit = parseInt(filterAttrs[2].split("=")[1]) 
                if (authors[0] == "all" && tags[0]!= "all" && limit == -1) {
                    db.collection('contents').find({
                        'json.tag': { $in: tags }
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all" && tags[0] != "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors } },
                            { 'json.tag': { $in: tags } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] == "all" && tags[0] == "all" && limit == -1) {
                    db.collection('contents').find({
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all"  && tags[0] == "all" && limit == -1) {
                    db.collection('contents').find({
                        author: { $in : authors },
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] == "all" && tags[0]!= "all" && limit != -1) {
                    db.collection('contents').find({
                        'json.tag': { $in: tags }
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all" && tags[0] != "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors } },
                            { 'json.tag': { $in: tags } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] == "all" && tags[0] == "all" && limit != -1) {
                    db.collection('contents').find({
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all"  && tags[0] == "all" && limit != -1) {
                    db.collection('contents').find({
                        author: { $in : authors },
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            } else if (filterAttrs.length == 4) {
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")
                tags = filterAttrs[1].split('=')[1]
                tags = tags.split(",")
                limit = parseInt(filterAttrs[2].split("=")[1])
                tsrange = filterAttrs[3].split("=")[1]
                tsrange = tsrange.split("-")
                if (tsrange.length == 2) {
                    tsfrom = parseInt(tsrange[0]) * 1000
                    tsto = parseInt(tsrange[1]) * 1000
                } else {
                    return
                } 
                if (authors[0] == "all" && tags[0]!= "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { 'json.tag': { $in: tags } },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all" && tags[0] != "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors } },
                            { 'json.tag': { $in: tags } },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] == "all" && tags[0] == "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ] 
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all"  && tags[0] == "all" && limit == -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors } },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] == "all" && tags[0]!= "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { 'json.tag': { $in: tags } },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all" && tags[0] != "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors } },
                            { 'json.tag': { $in: tags } },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] == "all" && tags[0] == "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ] 
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors[0] != "all"  && tags[0] == "all" && limit != -1) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors } },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
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
