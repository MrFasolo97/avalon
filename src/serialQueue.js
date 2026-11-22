// Serial async executor (H2).
//
// Runs tasks strictly one at a time, in FIFO order. Unlike the legacy callback
// ProcessingQueue this returns a promise per task, so callers can await the
// result and observe errors. A rejected task never poisons the queue: the
// internal tail always settles, so a failed block does not block the next one.
class SerialQueue {
    constructor() {
        this.tail = Promise.resolve()
        this.pending = 0
    }

    // Enqueue `task` and return its result. `task` is invoked with no arguments
    // only after every earlier task has settled.
    run(task) {
        if (typeof task !== 'function')
            return Promise.reject(new Error('SerialQueue.run expects a function'))
        this.pending++
        const result = this.tail.then(task)
        // Normalise the tail: next task runs regardless of this one's outcome,
        // while `result` still carries the error to this task's caller.
        this.tail = result.then(
            () => { this.pending-- },
            () => { this.pending-- }
        )
        return result
    }
}

module.exports = SerialQueue
