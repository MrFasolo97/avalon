// == Startup recovery for an interrupted automatic rollback (R9) ==
//
// The rollback marker is stored in its own Mongo collection so it survives the
// derived-state swap. This module is the single decision point for an incomplete
// marker and is called both by main.js at startup and by the crash-recovery
// test. No DB globals are touched here: every primitive is injected.

module.exports = {
    recover: async ({ mongo, blocks, logr }) => {
        if (!mongo || !mongo.getRollbackMarker) return null
        const marker = await mongo.getRollbackMarker()
        if (!marker) return null

        const warn = logr && logr.warn ? logr.warn.bind(logr) : () => {}
        const info = logr && logr.info ? logr.info.bind(logr) : () => {}
        warn('Incomplete rollback marker found at startup', marker)

        const truncate = async (ancestor) => {
            if (!Number.isInteger(ancestor)) return
            if (blocks && blocks.isOpen) {
                if (!blocks.truncate) throw new Error('no block truncation primitive available for rollback recovery')
                blocks.truncate(ancestor)
            } else if (mongo.truncateBlocks)
                await mongo.truncateBlocks(ancestor)
            else throw new Error('no block truncation primitive available for rollback recovery')
        }
        const finish = async (action, ancestor) => {
            // Staging copies and the temp DB are never canonical state.
            if (mongo.cleanupRebuildStaging) await mongo.cleanupRebuildStaging()
            if (mongo.dropRebuildTempDb) await mongo.dropRebuildTempDb()
            if (mongo.clearRollbackMarker) await mongo.clearRollbackMarker()
            if (!Number.isInteger(ancestor)) return { action, ancestor: null, head: null }
            const head = blocks && blocks.isOpen
                ? (blocks.lastBlock ? blocks.lastBlock() : null)
                : (mongo.lastBlock ? await mongo.lastBlock() : null)
            return { action, ancestor, head }
        }

        if (marker.phase === 'started') {
            const ancestor = Number.isInteger(marker.ancestor) ? marker.ancestor : null
            const stateHead = mongo.readStateHead ? await mongo.readStateHead() : null
            // `swapping` is written before the first rename. The head check also
            // covers markers written before that flag existed: after the swap the
            // persisted head has been replayed to the ancestor, never beyond it.
            const swapped = marker.swapping === true
                || (ancestor !== null && Number.isInteger(stateHead) && stateHead <= ancestor)
            if (swapped) {
                if (ancestor === null) throw new Error('rollback marker missing ancestor')
                // A crash mid-rename may have swapped only some collections.
                // Replaying the (idempotent) swap from the temp DB completes it.
                if (mongo.retryRebuildSwap) await mongo.retryRebuildSwap()
                await truncate(ancestor)
                info('Recovered interrupted rollback swap by truncating blocks to #' + ancestor)
                return finish('truncated-after-swap', ancestor)
            }
            if (mongo.discardRebuildTemp) await mongo.discardRebuildTemp()
            info('Rollback marker (started) cleared; original DB/blocks were not swapped')
            return finish('discarded-before-swap', null)
        }

        if (marker.phase === 'swapped') {
            const ancestor = Number.isInteger(marker.ancestor) ? marker.ancestor : null
            if (ancestor === null) throw new Error('rollback marker missing ancestor')
            await truncate(ancestor)
            info('Recovered swapped rollback by truncating blocks to #' + ancestor)
            return finish('truncated-after-swap', ancestor)
        }

        throw new Error('Unknown rollback marker phase: ' + marker.phase)
    }
}
