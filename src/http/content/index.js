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

            var filterMap = {}
            var defaultKeys = ['authors', 'tags', 'limit', 'tsrange']
            var filterKeys = []

            for (var k=0; k<filterAttrs.length; k++) {
                var kv = filterAttrs[k].split('=')

                if (kv.length == 2) {
                    var key = kv[0]
                    filterKeys.push(key)
                    var val = kv[1]

                    if (key == 'authors') {
                        filterMap['authors'] = val.split(',')
                    } else if (key == 'tags') {
                        filterMap['tags'] = val.split(',')
                    } else if (key == 'limit') {
                        filterMap['limit'] = parseInt(val) 
                    } else if (key == 'tsrange') {
                        filterMap['tsrange'] = val.split(',')
                    }
                }
            }
            console.log(filterKeys)

            for (var k=0; k<defaultKeys; k++) {
                var key = defaultKeys[k]
                console.log(key)

                if (filterKeys.includes(key) == false) {
                    console.log('here')
                    if (key == 'authors') {
                        filterMap['authors'] = []
                        filterMap['authors'].push("all") 
                    } else if (key == 'tags') {
                        filterMap['tags'] = val.split(',')
                        filterMap['authors'].push("all") 
                    } else if (key == 'limit') {
                        filterMap['limit'] = Number.MAX_SAFE_INTEGER
                    } else if (key == 'tsrange') {
                        filterMap['tsrange'] = []
                        filterMap['tsrange'].push(0)
                        filterMap['tsrange'].push(Number.MAX_SAFE_INTEGER)
                    } 
                }
            }

            console.log(filterMap)

            if (filterAttrs.length == 1) {
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")

                authors_in = []
                authors_ex = []
                for(var i=0; i<authors.length; i++) 
                    if(authors[i].includes("^")) 
                        authors_ex.push(authors[i])
                    else
                        authors_in.push(authors[i])

                if(authors_in.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $nin : authors_ex } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors_in } },
                            { author: { $nin : authors_ex } }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            } else if (filterAttrs.length == 2) {
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")

                authors_in = []
                authors_ex = []
                for(var i=0; i<authors.length; i++)  
                    if(authors[i].includes("^")) {
                        s = authors[i].substring(1, authors[i].length)
                        authors_ex.push(s)
                    }
                    else {
                        authors_in.push(authors[i])
                    }

                tags = filterAttrs[1].split('=')[1]
                tags = tags.split(",")

                tags_in = []
                tags_ex = []
                for(var i=0; i<tags.length; i++) 
                    if(tags[i].includes("^")) {
                        s = tags[i].substring(1, tags[i].length)
                        tags_ex.push(s)
                    } else {
                        tags_in.push(tags[i])
                    }

                console.log(authors_in)
                console.log(authors_ex)
                console.log(tags_in)
                console.log(tags_ex)

                if (authors.includes("all") && !tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 
                                        $and: [
                                            { 'json.tag': { $in: tags_in } },
                                            { 'json.tag': { $nin: tags_ex } },
                                        ],
                                    },
                                    { 
                                        $and: [
                                            { votes: { $elemMatch: { tag: { $in: tags_in } } } },
                                            { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                        ]
                                    }
                                ]
                            }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (!authors.includes("all") && !tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors_in } },
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 
                                        $and: [
                                            { 'json.tag': { $in: tags_in } },
                                            { 'json.tag': { $nin: tags_ex } },
                                        ],
                                    },
                                    { 
                                        $and: [
                                            { votes: { $elemMatch: { tag: { $in: tags_in } } } },
                                            { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                        ]
                                    }
                                ]
                            }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors.includes("all") && tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 'json.tag': { $nin: tags_ex } },
                                    { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                ]
                            }
                        ] 
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (!authors.includes("all")  && tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors_in } },
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 'json.tag': { $nin: tags_ex } },
                                    { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                ]
                            }
                        ]
                    }, { sort: {ts:-1} }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            } else if (filterAttrs.length == 3) {  
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")

                authors_in = []
                authors_ex = []
                for(var i=0; i<authors.length; i++)  
                    if(authors[i].includes("^")) {
                        s = authors[i].substring(1, authors[i].length)
                        authors_ex.push(s)
                    }
                    else {
                        authors_in.push(authors[i])
                    }

                tags = filterAttrs[1].split('=')[1]
                tags = tags.split(",")

                tags_in = []
                tags_ex = []
                for(var i=0; i<tags.length; i++) 
                    if(tags[i].includes("^")) {
                        s = tags[i].substring(1, tags[i].length)
                        tags_ex.push(s)
                    } else {
                        tags_in.push(tags[i])
                    }

                limit = parseInt(filterAttrs[2].split("=")[1]) 

                if(limit == -1) {
                    limit = Number.MAX_SAFE_INTEGER
                }

                if (authors.includes("all") && !tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 
                                        $and: [
                                            { 'json.tag': { $in: tags_in } },
                                            { 'json.tag': { $nin: tags_ex } },
                                        ],
                                    },
                                    { 
                                        $and: [
                                            { votes: { $elemMatch: { tag: { $in: tags_in } } } },
                                            { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                        ]
                                    }
                                ]
                            }
                        ]
                    }, { sort: {ts:-1}, limit: limit}).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (!authors.includes("all") && !tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors_in } },
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 
                                        $and: [
                                            { 'json.tag': { $in: tags_in } },
                                            { 'json.tag': { $nin: tags_ex } },
                                        ],
                                    },
                                    { 
                                        $and: [
                                            { votes: { $elemMatch: { tag: { $in: tags_in } } } },
                                            { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                        ]
                                    }
                                ]
                            }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors.includes("all") && tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 'json.tag': { $nin: tags_ex } },
                                    { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                ]
                            }
                        ] 
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (!authors.includes("all")  && tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors_in } },
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 'json.tag': { $nin: tags_ex } },
                                    { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                ]
                            }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                }
            } else if (filterAttrs.length == 4) {
                authors = filterAttrs[0].split('=')[1]
                authors = authors.split(",")

                authors_in = []
                authors_ex = []
                for(var i=0; i<authors.length; i++)  
                    if(authors[i].includes("^")) {
                        s = authors[i].substring(1, authors[i].length)
                        authors_ex.push(s)
                    }
                    else {
                        authors_in.push(authors[i])
                    }

                tags = filterAttrs[1].split('=')[1]
                tags = tags.split(",")

                tags_in = []
                tags_ex = []
                for(var i=0; i<tags.length; i++) 
                    if(tags[i].includes("^")) {
                        s = tags[i].substring(1, tags[i].length)
                        tags_ex.push(s)
                    } else {
                        tags_in.push(tags[i])
                    }

                limit = parseInt(filterAttrs[2].split("=")[1]) 

                if(limit == -1) {
                    limit = Number.MAX_SAFE_INTEGER
                }

                tsrange = filterAttrs[3].split("=")[1]
                tsrange = tsrange.split(",")
                if (tsrange.length == 2) {
                    tsfrom = parseInt(tsrange[0]) * 1000
                    tsto = parseInt(tsrange[1]) * 1000
                } else {
                    return
                } 

                if (authors.includes("all") && !tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 
                                        $and: [
                                            { 'json.tag': { $in: tags_in } },
                                            { 'json.tag': { $nin: tags_ex } },
                                        ],
                                    },
                                    { 
                                        $and: [
                                            { votes: { $elemMatch: { tag: { $in: tags_in } } } },
                                            { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                        ]
                                    }
                                ]
                            },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit}).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (!authors.includes("all") && !tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors_in } },
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 
                                        $and: [
                                            { 'json.tag': { $in: tags_in } },
                                            { 'json.tag': { $nin: tags_ex } },
                                        ],
                                    },
                                    { 
                                        $and: [
                                            { votes: { $elemMatch: { tag: { $in: tags_in } } } },
                                            { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                        ]
                                    }
                                ]
                            },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ]
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (authors.includes("all") && tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 'json.tag': { $nin: tags_ex } },
                                    { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                ]
                            },
                            { ts: { $gte: tsfrom } },
                            { ts: { $lte: tsto } }
                        ] 
                    }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                        res.send(contents)
                    })
                } else if (!authors.includes("all")  && tags.includes("all")) {
                    db.collection('contents').find({
                        $and: [
                            { author: { $in : authors_in } },
                            { author: { $nin : authors_ex } },
                            { 
                                $or: [
                                    { 'json.tag': { $nin: tags_ex } },
                                    { votes: { $elemMatch: { tag: { $nin: tags_ex } } } } 
                                ]
                            },
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
