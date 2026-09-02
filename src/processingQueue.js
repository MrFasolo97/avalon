class ProcessingQueue {
    constructor() {
        this.queue = []
        this.processing = false
    }

    push(f = (cb) => cb()) {
        this.queue.push(f)
        if (!this.processing) {
            this.processing = true
            this.execute()
        }
    }

    execute() {
        let first = this.queue.shift()
        let cb = () => {
            if (this.queue.length > 0)
                this.execute()
            else
                this.processing = false
        }
        try { first(cb) } catch(e) { logr.error('queue error', e); cb() }
    }
}

module.exports = ProcessingQueue