class ProcessingQueue {
    constructor() {
        this.queue = []
        this.processing = false
    }

    // `f` is a callback-style task: (done) => done(err). Errors used to be
    // logged and dropped by the queue; callers that care can now pass an
    // `onError` handler to receive them (H2).
    push(f = (cb) => cb(), onError) {
        this.queue.push({ f, onError })
        if (!this.processing) {
            this.processing = true
            this.execute()
        }
    }

    execute() {
        const item = this.queue.shift()
        let settled = false
        const cb = (err) => {
            // A task must complete exactly once: a double callback would start
            // the next task twice and break serialization.
            if (settled) return
            settled = true
            if (err && typeof item.onError === 'function') {
                const handler = item.onError
                try { handler(err) } catch (e) { logr.error('queue error handler failed', e) }
            }
            if (this.queue.length > 0)
                this.execute()
            else
                this.processing = false
        }
        try { item.f(cb) } catch (e) { cb(e) }
    }
}

module.exports = ProcessingQueue
