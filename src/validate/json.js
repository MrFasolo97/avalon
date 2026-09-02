// content json and profile

function hasInvalidKeys(obj) {
    if (Array.isArray(obj))
        return obj.some(hasInvalidKeys)
    if (obj && typeof obj === 'object')
        for (const k of Object.keys(obj))
            if (k.includes('.') || k.includes('$') || hasInvalidKeys(obj[k]))
                return true
    return false
}

module.exports = (value, max) => {
    if (!value)
        return false
    if (typeof value !== 'object')
        return false
    if (hasInvalidKeys(value))
        return false
    try {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max)
            return false
    } catch (error) {
        return false
    }

    return true
}