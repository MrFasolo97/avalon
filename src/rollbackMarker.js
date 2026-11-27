// == Rollback marker storage (R9) ==
//
// The marker is deliberately kept OUTSIDE the derived `state` collection: a
// rollback swaps `state` by renaming a staging collection over it, which would
// erase a marker stored there before the `swapped` transition is written.
// A dedicated collection is never renamed, dropped or snapshotted, so a crash
// in the swap window is always recoverable at startup.
//
// Shared by mongo.js (read/write/clear) and stateSnapshot.js (exclusion guard)
// to avoid a require cycle between those two modules.

module.exports = {
    collection: 'rollback_marker',
    id: 'rollback'
}
