const http_port = process.env.HTTP_PORT || 3001
const http_host = process.env.HTTP_HOST || "127.0.0.1"
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const rateLimit = require('express-rate-limit')
const fs = require('fs')

const globalLimiter = rateLimit({
    windowMs: 1000,
    max: 50,
    message: { error: 'too many requests' }
})

const strictLimiter = rateLimit({
    windowMs: 1000,
    max: 5,
    message: { error: 'too many requests' }
})

let http = {
    init: () => {
        let app = express()
        app.use(cors({
            origin: process.env.CORS_ORIGIN || false
        }))
        app.use(bodyParser.json({ limit: '10kb' }))
        app.use(globalLimiter)

        // any folder in the /http/ folder is a different api endpoint
        let endpoints = fs.readdirSync(__dirname, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
        for (let i = 0; i < endpoints.length; i++)
            try {
                require(__dirname+'/'+endpoints[i]).init(app)
                logr.debug('Initialized API endpoint /'+endpoints[i])
            } catch (error) {
                logr.error('Failed to load API endpoint /'+endpoints[i])
            }
            
        app.listen(http_port, http_host, () => logr.info('Listening http on port: ' + http_port))
    }
}

module.exports = http
