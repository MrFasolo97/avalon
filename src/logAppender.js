const logBuffer = require('./logBuffer')

function appender(config, layouts) {
    const layout = layouts.basicLayout

    return function(logEvent) {
        const formatted = layout(logEvent, config)
        logBuffer.append(formatted, logEvent.level.levelStr)
    }
}

appender.configure = appender

module.exports = appender
