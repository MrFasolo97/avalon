const sharp = require('sharp')
const fetch = require('node-fetch-commonjs')
const { URL } = require('url')
const net = require('net')
const http = require('http')
const https = require('https')
const tls = require('tls')
const rateLimit = require('express-rate-limit')
const { isPrivateURL, resolveAndPin, checkRebinding } = require('../ssrf')
const logr = require('../../logger.js')

const QUALITY = 95
const AVATAR_WIDTH = {
    small: 64,
    medium: 128, // default
    large: 512
}
const DEFAULT_AVATAR = 'https://steemitimages.com/DQmb2HNSGKN3pakguJ4ChCRjgkVuDN9WniFRPmrxoJ4sjR4'
const CACHE_SIZE = Math.max(parseInt(process.env.IMG_CACHE_SIZE) || 52428800, -1)
const CACHE_TIME = parseInt(process.env.IMG_CACHE_TIME) || 900000 // 15 minutes default
// Cap remote image downloads to bound memory: sharp decodes into RAM, so an
// oversized/decompression-bomb input could OOM the node.
const MAX_DOWNLOAD_BYTES = parseInt(process.env.IMG_MAX_BYTES) || 10 * 1024 * 1024
const MAX_INPUT_PIXELS = parseInt(process.env.IMG_MAX_PIXELS) || 20 * 1000 * 1000

const imageLimiter = rateLimit({
    windowMs: 60000,
    max: 60,
    message: { error: 'too many requests' }
})


let imageCache = {
    avatar: {
        small: {},
        medium: {},
        large: {}
    },
    cover: {}
}
let imageCacheBytes = 0

module.exports = {
    init: (app) => {
        /**
         * @api {get} /image/avatar/:name/:size Avatar
         * @apiName avatar
         * @apiGroup Image
         * 
         * @apiParam {String} name Username to retrieve avatar of
         * @apiParam {String} size Size of avatar. Valid values: `small`, `medium` and `large`.
         * 
         * @apiSuccess {Binary} image The image file of the avatar
         * @apiSampleRequest off
         */
        app.get('/image/avatar/:name/:size?', imageLimiter, (req, res) => {
            if (!req.params.name)
                return res.status(400).send({error: 'username is required'})
            let size = req.params.size || 'medium'
            if (!imageCache.avatar[size] || size.startsWith('default_') || size === '')
                size = 'medium'

            // Return cached image if available
            if (imageCache.avatar[size][req.params.name] && imageCache.avatar[size][req.params.name].t) {
                imageCache.avatar[size][req.params.name].t = new Date().getTime()
                if (!imageCache.avatar[size][req.params.name].d && imageCache.avatar['default_'+size])
                    return imageResponse(res,Buffer.from(imageCache.avatar['default_'+size]))
                else if (imageCache.avatar[size][req.params.name].d)
                    return imageResponse(res,Buffer.from(imageCache.avatar[size][req.params.name].d))
            }

            // If not look for image url and fetch
            db.collection('accounts').findOne({ name: req.params.name }, function (err, account) {
                if (err) return res.status(400).send({error: 'could not retrieve account info'})
                if (!account) return res.status(404).send({error: 'username does not exist'})
                // todo return default avatar if no avatar url in metadata
                let isDefault = false
                let imageUrl = ''
                if (!account.json || !account.json.profile || !account.json.profile.avatar) {
                    isDefault = true
                    imageUrl = DEFAULT_AVATAR
                } else {
                    imageUrl = account.json.profile.avatar
                    if (!imageUrl.startsWith('http')) {
                        isDefault = true
                        imageUrl = DEFAULT_AVATAR
                    }
                }

                fetchAndRespondImage(imageUrl,res,AVATAR_WIDTH[size],AVATAR_WIDTH[size],(imgJson) => {
                    if (isDefault) {
                        const key = 'default_'+size
                        if (!imageCache.avatar[key])
                            imageCacheBytes += JSON.stringify(imgJson).length
                        imageCache.avatar[key] = imgJson
                    } else if (imageCacheBytes < CACHE_SIZE) {
                        const entry = { t: new Date().getTime(), d: imgJson }
                        imageCache.avatar[size][req.params.name] = entry
                        imageCacheBytes += JSON.stringify(entry).length
                    }
                })
            })
        })

        /**
         * @api {get} /image/cover/:name Cover
         * @apiName cover
         * @apiGroup Image
         * 
         * @apiParam {String} name Username to retrieve channel cover of
         * 
         * @apiSuccess {Binary} image The image file of the cover
         * @apiSampleRequest off
         */
        app.get('/image/cover/:name', imageLimiter, (req,res) => {
            if (!req.params.name)
                return res.status(400).send({error: 'username is required'})
            if (imageCache.cover[req.params.name] && imageCache.cover[req.params.name].d) {
                imageCache.cover[req.params.name].t = new Date().getTime()
                return imageResponse(res,Buffer.from(imageCache.cover[req.params.name].d))
            }
            db.collection('accounts').findOne({ name: req.params.name }, function (err, account) {
                if (err) return res.status(400).send({error: 'could not retrieve account info'})
                if (!account) return res.status(404).send({error: 'username does not exist'})
                if (!account.json || !account.json.profile || !account.json.profile.cover_image)
                    return res.status(404).send({error: 'cover image url not available'})
                const imageUrl = account.json.profile.cover_image
                if (!imageUrl.startsWith('http'))
                    return res.status(404).send({error: 'invalid cover image url'})

                fetchAndRespondImage(imageUrl,res,2048,512,(imgJson) => {
                    if (imageCacheBytes < CACHE_SIZE) {
                        const entry = { t: new Date().getTime(), d: imgJson }
                        imageCache.cover[req.params.name] = entry
                        imageCacheBytes += JSON.stringify(entry).length
                    }
                })
            })
        })

        app.get('/image/cachesize',(req,res) => {
            res.send({size: imageCacheBytes})
        })

        // cleanup cache
        setInterval(() => {
            let timeNow = new Date().getTime()
            for (let s in imageCache.avatar) if (!s.startsWith('default_')) for (let u in imageCache.avatar[s])
                if (timeNow - imageCache.avatar[s][u].t > CACHE_TIME) {
                    imageCacheBytes -= JSON.stringify(imageCache.avatar[s][u]).length
                    delete imageCache.avatar[s][u]
                }
            for (let u in imageCache.cover)
                if (timeNow - imageCache.cover[u].t > CACHE_TIME) {
                    imageCacheBytes -= JSON.stringify(imageCache.cover[u]).length
                    delete imageCache.cover[u]
                }
        },30000)
    }
}

async function fetchAndRespondImage(imageUrl,res,width,height,cacher,redirectsRemaining = 5) {
    try {
        if (await isPrivateURL(imageUrl))
            return res.status(400).send({error: 'invalid image url'})
        const parsed = new URL(imageUrl)
        const pinnedIp = await resolveAndPin(parsed.hostname)
        if (!pinnedIp)
            return res.status(400).send({error: 'could not resolve host'})
        if (await isPrivateURL('http://' + pinnedIp))
            return res.status(400).send({error: 'invalid image url'})
        if (!(await checkRebinding(parsed.hostname, pinnedIp)))
            return res.status(400).send({error: 'dns rebinding detected'})
        // Keep original hostname for SNI/TLS; pin IP via custom agent lookup
        const isHttps = parsed.protocol === 'https:'
        const pinAgent = isHttps
            ? new https.Agent({ createConnection: (opts, cb) => {
                opts.servername = parsed.hostname
                opts.host = pinnedIp
                return tls.connect(opts, cb)
            }})
            : new http.Agent({ createConnection: (opts, cb) => {
                opts.host = pinnedIp
                return net.createConnection(opts, cb)
            }})
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        let imgFetch
        try {
            imgFetch = await fetch(imageUrl, {
                signal: controller.signal,
                redirect: 'manual',
                agent: pinAgent
            })
        } finally {
            clearTimeout(timeout)
        }
        if (imgFetch.status >= 300 && imgFetch.status < 400) {
            if (redirectsRemaining <= 0) 
                return res.status(400).send({error: 'too many redirects'})
            
            const location = imgFetch.headers.get('location')
            if (location) {
                // Resolve relative redirects against the original URL
                const resolvedLocation = new URL(location, imageUrl).toString()
                if (await isPrivateURL(resolvedLocation)) 
                    return res.status(400).send({error: 'invalid image url'})
                
                const locParsed = new URL(resolvedLocation)
                const locPinned = await resolveAndPin(locParsed.hostname)
                if (!locPinned || !(await checkRebinding(locParsed.hostname, locPinned))) 
                    return res.status(400).send({error: 'dns rebinding detected on redirect'})
                
                return fetchAndRespondImage(resolvedLocation, res, width, height, cacher, redirectsRemaining - 1)
            }
            return res.status(400).send({error: 'redirect not allowed'})
        }
        const contentLength = parseInt(imgFetch.headers.get('content-length') || '0', 10)
        if (contentLength > MAX_DOWNLOAD_BYTES)
            return res.status(400).send({error: 'image too large'})

        let buffer = await readCappedBody(imgFetch, MAX_DOWNLOAD_BYTES)
        if (!buffer)
            return res.status(400).send({error: 'image too large'})
        let img = await resizeImage(buffer,width,height)
        imageResponse(res,img)
        await cacher(await img.toJSON())
    } catch (e) {
        logr.debug(e)
        res.status(500).send({error: 'errored while retrieving avatar'})
    }
}

// Reads at most maxBytes from the response body, aborting as soon as the cap is
// exceeded so a lying/omitted Content-Length cannot force an unbounded buffer.
function readCappedBody(resp, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let total = 0
        let done = false
        const finish = (err, val) => {
            if (done) return
            done = true
            if (err) reject(err); else resolve(val)
        }
        resp.body.on('data', (chunk) => {
            total += chunk.length
            if (total > maxBytes) {
                resp.body.destroy()
                return finish(null, null)
            }
            chunks.push(chunk)
        })
        resp.body.on('end', () => finish(null, Buffer.concat(chunks)))
        resp.body.on('error', (err) => finish(err))
    })
}

function resizeImage(buf,width,height) {
    return new Promise((rs,rj) => {
        sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
            .resize(width,height)
            .toFormat('png',{quality: QUALITY})
            .toBuffer((err, data) => {
                if (err) return rj(err)
                rs(data)
            })
    })
}

function imageResponse(res,img) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'image/png')
    res.send(img)
}
