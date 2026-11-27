// == Runtime build commit resolution (R6) ==
//
// `GIT_COMMIT` is baked into Docker images at build time. A source checkout
// without that build arg still reports its real git HEAD. Only when neither
// source is available do we fall back to "unknown" — a stale hardcoded value
// would make two releases indistinguishable in /version and NODE_STATUS.
//
// Injection is intentional: unit tests can exercise every branch without
// spawning git or mutating the process environment.

const path = require('path')
const { execFileSync } = require('child_process')

const REPO_ROOT = path.join(__dirname, '..')

const clean = (value) => {
    if (value === undefined || value === null) return ''
    return String(value).trim()
}

const resolveCommitHash = (opts = {}) => {
    const env = opts.env || process.env
    const fromEnv = clean(env.GIT_COMMIT) || clean(env.AVALON_COMMIT)
    if (fromEnv) return fromEnv

    const run = opts.exec || ((cmd, args, config) => execFileSync(cmd, args, config))
    try {
        const out = run('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: opts.cwd || REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        })
        const fromGit = clean(out)
        if (fromGit) return fromGit
    } catch (e) {}
    return 'unknown'
}

module.exports = {
    resolve: resolveCommitHash,
    current: () => resolveCommitHash()
}
