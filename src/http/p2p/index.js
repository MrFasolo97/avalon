const rateLimit = require('express-rate-limit')

const p2pLimiter = rateLimit({
    windowMs: 1000,
    max: 20,
    message: { error: 'too many requests' }
})

module.exports = {
    init: (app) => {
        app.use('/p2p', p2pLimiter)

        /**
         * @api {get} /p2p P2PVideos
         * @apiName p2p
         * @apiGroup Rankings
         * 
         * @apiSuccess {Object[]} contents List of new p2p contents
         */
        app.get('/p2p', (req, res) => {
            db.collection('contents').find({$and: [{pa: null }, {$or: [{'json.files.ipfs': {$ne: null}},{'json.files.btfs': {$ne: null}}, {'json.files.sia': { $ne: null}}]}]}, { sort: { ts: -1 }, limit: 50 }).toArray(function (err, contents) {
                res.send(contents)
            })
        })

        /**
         * @api {get} /p2p/:author/:link P2PVideos (continued)
         * @apiName p2pContinued
         * @apiGroup Rankings
         * 
         * @apiParam {String} author Author of post to continue from
         * @apiParam {String} link Permlink of post to continue from
         * 
         * @apiSuccess {Object[]} contents List of new p2p contents continued
         */
        app.get('/p2p/:author/:link', (req, res) => {
            db.collection('contents').findOne({
                $and: [
                    { author: req.params.author },
                    { link: req.params.link }
                ]
            }, function (err, content) {
                if (!content) {
                    res.sendStatus(404)
                    return
                }
                db.collection('contents').find({
                    $and: [
                        { pa: null },
                        {$or: [{'json.files.ipfs': {$ne: null}},{'json.files.btfs': {$ne: null}}, {'json.files.sia': { $ne: null}}]},
                        { ts: { $lte: content.ts } }
                    ]
                }, { sort: { ts: -1 }, limit: 50 }).toArray(function (err, contents) {
                    res.send(contents)
                })
            })
        })

        // get new contents with filter by author, tag, limit, tsrange
        /**
         * @api {get} /p2p P2PVideos Filtered
         * @apiName p2pFiltered
         * @apiGroup Rankings
         * 
         * @apiParam {String} filter Filter parameters
         * 
         * @apiSuccess {Object[]} contents List of new p2p contents filtered
         */
        app.get('/p2p/:filter', (req, res) => {
            let filterParam = req.params.filter
            let filter = filterParam.split(':')
            let filterBy = filter[1]
            if (!filterBy)
                return res.status(400).send({error: 'invalid filter'})
            let filterAttrs = []
            if (filterBy !== null)
                filterAttrs = filterBy.split('&')
            

            let filterMap = {}
            let defaultKeys = ['authors', 'tags', 'limit', 'tsrange']
            let filterKeys = []

            for (let k=0; k<filterAttrs.length; k++) {
                let kv = filterAttrs[k].split('=')

                if (kv.length === 2) {
                    let key = kv[0]
                    filterKeys.push(key)
                    let val = kv[1]

                    if (key === 'authors') 
                        filterMap['authors'] = val.split(',')
                    else if (key === 'tags') 
                        filterMap['tags'] = val.split(',')
                    else if (key === 'limit') 
                        filterMap['limit'] = parseInt(val)
                    else if (key === 'tsrange') 
                        filterMap['tsrange'] = val.split(',')
                }
            }

            for (let k=0; k<defaultKeys.length; k++) {
                let key = defaultKeys[k]

                if (!filterKeys.includes(key)) 
                    if (key === 'authors') {
                        filterMap['authors'] = []
                        filterMap['authors'].push('all')
                    } else if (key === 'tags') {
                        filterMap['tags'] = []
                        filterMap['tags'].push('all')
                    } else if (key === 'limit') 
                        filterMap['limit'] = 50
                    else if (key === 'tsrange') {
                        filterMap['tsrange'] = []
                        filterMap['tsrange'].push(0)
                        filterMap['tsrange'].push(Number.MAX_SAFE_INTEGER)
                    }
            }

            let authors = filterMap['authors']

            let authors_in = []
            let authors_ex = []
            for(let i=0; i<authors.length; i++) 
                if(authors[i].includes('^'))
                    authors_ex.push(authors[i].substring(1, authors[i].length))
                else 
                    authors_in.push(authors[i])

            let tags = filterMap['tags']

            let tags_in = []
            let tags_ex = []
            for(let i=0; i<tags.length; i++) 
                if(tags[i].includes('^'))
                    tags_ex.push(tags[i].substring(1, tags[i].length))
                else 
                    tags_in.push(tags[i])

            let limit = filterMap['limit']

            if (isNaN(limit) || limit < 1 || limit > 100)
                limit = 50

            let tsrange = filterMap['tsrange']
            let tsfrom, tsto
            if (tsrange.length === 2) {
                tsfrom = parseInt(tsrange[0]) * 1000
                tsto = parseInt(tsrange[1]) * 1000
            } else
                return res.status(400).send({error: 'invalid tsrange'})

            if (authors.includes('all') && !tags.includes('all')) 
                db.collection('contents').find({
                    $and: [
                        { pa: null },
                        { author: { $nin : authors_ex } },
                        {$or: [{'json.files.ipfs': {$ne: null}},{'json.files.btfs': {$ne: null}}, {'json.files.sia': { $ne: null}}]},
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
            else if (!authors.includes('all') && !tags.includes('all')) 
                db.collection('contents').find({
                    $and: [
                        { pa: null },
                        { author: { $in : authors_in } },
                        { author: { $nin : authors_ex } },
                        {$or: [{'json.files.ipfs': {$ne: null}},{'json.files.btfs': {$ne: null}}, {'json.files.sia': { $ne: null}}]},
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
            else if (authors.includes('all') && tags.includes('all')) 
                db.collection('contents').find({
                    $and: [
                        { pa: null },
                        {$or: [{'json.files.ipfs': {$ne: null}},{'json.files.btfs': {$ne: null}}, {'json.files.sia': {$ne: null}}]},
                        { author: { $nin : authors_ex } },
                        { 'json.tag': { $nin: tags_ex } },
                        { votes: { $elemMatch: { tag: { $nin: tags_ex } } } },
                        { ts: { $gte: tsfrom } },
                        { ts: { $lte: tsto } }
                    ]
                }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                    res.send(contents)
                })
            else if (!authors.includes('all')  && tags.includes('all')) 
                db.collection('contents').find({
                    $and: [
                        { pa: null },
                        { author: { $in : authors_in } },
                        { author: { $nin : authors_ex } },
                        {$or: [{'json.files.ipfs': {$ne: null}},{'json.files.btfs': {$ne: null}}, {'json.files.sia': { $ne: null}}]},
                        { 'json.tag': { $nin: tags_ex } },
                        { votes: { $elemMatch: { tag: { $nin: tags_ex } } } },
                        { ts: { $gte: tsfrom } },
                        { ts: { $lte: tsto } }
                    ]
                }, { sort: {ts:-1}, limit: limit }).toArray(function (err, contents) {
                    res.send(contents)
                })
        })
    }
}
