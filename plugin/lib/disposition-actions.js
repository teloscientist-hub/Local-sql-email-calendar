"use strict";
// disposition-actions.js
//
// Shared helper for moving the currently-selected thread(s) into a named
// destination folder/label. Called from BOTH the toolbar buttons
// (Increment C) and the keymap handlers (Increment D), so they always
// behave identically.
//
// The move recipe is copied from Mailspring's own category-picker
// (internal_packages/category-picker/lib/move-picker-popover.js, the
// _onMoveToCategory handler):
//
//   - Destination is a Folder (IMAP/Zoho): ChangeFolderTask, single
//     folder move. Class is `ChangeFolderTask` (singular!), not
//     `ChangeFoldersTask`.
//   - Destination is a Label (Gmail):       ChangeLabelsTask,
//     removing ALL existing labels (which includes Inbox) and adding
//     the destination label. The thread fully leaves Inbox.
//
// Folder discovery: CategoryStore.categories(account) is matched by
// `displayName` against `folderName`. The owner pre-creates the four
// disposition folders/labels in each provider's web UI; the plugin only
// looks them up by name.
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
// Mailspring's thread-list-store auto-focuses the NEXT-OLDER thread after
// a move (it prefers an unread previous neighbor; in a busy inbox that's
// almost always the next-older thread, which moves the user backward in
// time). This helper finds the next-NEWER unmoved thread BEFORE we queue
// the task, and pre-emptively focuses it. Once the data change arrives,
// the auto-focus heuristic sees `focused` is still in the next dataSource
// and leaves it alone.
function _findNextNewerThread(threadsBeingMoved) {
    try {
        if (!mailspring_exports_1.ThreadListStore || typeof mailspring_exports_1.ThreadListStore.dataSource !== 'function')
            return null;
        const ds = mailspring_exports_1.ThreadListStore.dataSource();
        if (!ds || typeof ds.offsetOfId !== 'function' || typeof ds.modelAtOffset !== 'function') {
            return null;
        }
        const movingIds = new Set((threadsBeingMoved || []).map((t) => t && t.id).filter(Boolean));
        if (movingIds.size === 0)
            return null;
        // Lowest index among moved threads = newest moved thread.
        let minIndex = Infinity;
        for (const id of movingIds) {
            const idx = ds.offsetOfId(id);
            if (idx >= 0 && idx < minIndex)
                minIndex = idx;
        }
        if (!Number.isFinite(minIndex))
            return null;
        // Walk upward (newer) until we hit a thread NOT being moved.
        for (let i = minIndex - 1; i >= 0; i--) {
            const candidate = ds.modelAtOffset(i);
            if (candidate && !movingIds.has(candidate.id))
                return candidate;
        }
        return null;
    }
    catch (_err) {
        return null;
    }
}
// Note: 'Complete' (not 'Done') because Gmail reserves the label name
// 'Done' for system use and refuses to let users create it. We use the
// same vocabulary across both providers for consistency.
exports.DISPOSITIONS = ['Pending', 'Waiting', 'Complete', 'Later'];
function findCategoryByName(account, name) {
    const cats = mailspring_exports_1.CategoryStore.categories(account) || [];
    return cats.find(c => c && c.displayName === name) || null;
}
function focusedThreads() {
    // Multi-select case first: ThreadListStore's selection.
    if (mailspring_exports_1.ThreadListStore && mailspring_exports_1.ThreadListStore.dataSource) {
        const ds = mailspring_exports_1.ThreadListStore.dataSource();
        if (ds && ds.selection) {
            const sel = ds.selection.items();
            if (sel && sel.length > 0)
                return sel;
        }
    }
    // Single focused thread fallback.
    const focused = mailspring_exports_1.FocusedContentStore.focused('thread');
    return focused ? [focused] : [];
}
function moveSelectedTo(folderName, explicitThreads) {
    const threads = (explicitThreads && explicitThreads.length > 0)
        ? explicitThreads
        : focusedThreads();
    if (!threads || threads.length === 0) {
        // eslint-disable-next-line no-console
        console.info(`[mml-engagement-spike] moveSelectedTo(${folderName}): no threads selected.`);
        return { queued: 0, skipped: 0 };
    }
    // Capture the next-newer thread BEFORE the move so we can pre-empt
    // Mailspring's "prefer older unread" auto-focus heuristic.
    const nextNewer = _findNextNewerThread(threads);
    // Group by accountId — one task per account.
    const byAccount = {};
    for (const t of threads) {
        if (!t || !t.accountId)
            continue;
        (byAccount[t.accountId] = byAccount[t.accountId] || []).push(t);
    }
    let queued = 0;
    let skipped = 0;
    for (const accountId of Object.keys(byAccount)) {
        const account = mailspring_exports_1.AccountStore.accountForId(accountId);
        if (!account) {
            skipped += byAccount[accountId].length;
            continue;
        }
        const dest = findCategoryByName(account, folderName);
        if (!dest) {
            // eslint-disable-next-line no-console
            console.warn(`[mml-engagement-spike] No "${folderName}" folder/label in account ` +
                `${account.emailAddress}. Pre-create it in the provider's web UI.`);
            skipped += byAccount[accountId].length;
            continue;
        }
        const accountThreads = byAccount[accountId];
        let task;
        if (dest instanceof mailspring_exports_1.Folder) {
            // IMAP / non-Gmail folder.
            task = new mailspring_exports_1.ChangeFolderTask({
                source: 'mml-engagement-spike',
                threads: accountThreads,
                folder: dest,
            });
        }
        else {
            // Gmail label. Remove all current labels (including Inbox), apply dest.
            const labelsToRemove = [];
            for (const t of accountThreads) {
                if (t && Array.isArray(t.labels)) {
                    for (const l of t.labels)
                        labelsToRemove.push(l);
                }
            }
            task = new mailspring_exports_1.ChangeLabelsTask({
                source: 'mml-engagement-spike',
                threads: accountThreads,
                labelsToAdd: [dest],
                labelsToRemove,
            });
        }
        mailspring_exports_1.Actions.queueTask(task);
        queued += accountThreads.length;
    }
    // eslint-disable-next-line no-console
    console.info(`[mml-engagement-spike] moveSelectedTo(${folderName}): queued=${queued} skipped=${skipped}`);
    // Pre-empt the auto-focus heuristic with the next-newer unmoved thread.
    // Mailspring updates the thread list either synchronously via performLocal
    // (optimistic) or after mailsync confirms (~1-2s). In either case its
    // _onDataChanged heuristic prefers the next-OLDER thread, so we set focus
    // multiple times across a 1.5s window to win the race regardless of when
    // the heuristic fires.
    // eslint-disable-next-line no-console
    console.info(`[mml-productivity] post-move focus → ${nextNewer ? `thread ${nextNewer.id} (${(nextNewer.subject || '').slice(0, 40)})` : '(none — newest moved or list empty)'}`);
    if (queued > 0 && nextNewer) {
        const setBoth = () => {
            try {
                mailspring_exports_1.Actions.setFocus({ collection: 'thread', item: nextNewer });
                mailspring_exports_1.Actions.setCursorPosition({ collection: 'thread', item: nextNewer });
            }
            catch (_e) { /* noop */ }
        };
        // Three shots: immediately (before optimistic update), after the
        // current callstack (after optimistic update), and after mailsync ack.
        setBoth();
        setTimeout(setBoth, 50);
        setTimeout(setBoth, 1500);
    }
    return { queued, skipped };
}
exports.moveSelectedTo = moveSelectedTo;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlzcG9zaXRpb24tYWN0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9kaXNwb3NpdGlvbi1hY3Rpb25zLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSx5QkFBeUI7QUFDekIsRUFBRTtBQUNGLHlFQUF5RTtBQUN6RSxpRUFBaUU7QUFDakUsc0VBQXNFO0FBQ3RFLHNCQUFzQjtBQUN0QixFQUFFO0FBQ0Ysa0VBQWtFO0FBQ2xFLHFFQUFxRTtBQUNyRSw4QkFBOEI7QUFDOUIsRUFBRTtBQUNGLG9FQUFvRTtBQUNwRSxnRUFBZ0U7QUFDaEUsMkJBQTJCO0FBQzNCLDhEQUE4RDtBQUM5RCxxRUFBcUU7QUFDckUsNERBQTREO0FBQzVELEVBQUU7QUFDRixvRUFBb0U7QUFDcEUsZ0VBQWdFO0FBQ2hFLHdFQUF3RTtBQUN4RSx5QkFBeUI7O0FBRXpCLDJEQVM0QjtBQUU1QiwwRUFBMEU7QUFDMUUseUVBQXlFO0FBQ3pFLHdFQUF3RTtBQUN4RSx5RUFBeUU7QUFDekUsd0VBQXdFO0FBQ3hFLDBFQUEwRTtBQUMxRSx1QkFBdUI7QUFDdkIsU0FBUyxvQkFBb0IsQ0FBQyxpQkFBaUI7SUFDN0MsSUFBSTtRQUNGLElBQUksQ0FBQyxvQ0FBZSxJQUFJLE9BQU8sb0NBQWUsQ0FBQyxVQUFVLEtBQUssVUFBVTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ3RGLE1BQU0sRUFBRSxHQUFHLG9DQUFlLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDeEMsSUFBSSxDQUFDLEVBQUUsSUFBSSxPQUFPLEVBQUUsQ0FBQyxVQUFVLEtBQUssVUFBVSxJQUFJLE9BQU8sRUFBRSxDQUFDLGFBQWEsS0FBSyxVQUFVLEVBQUU7WUFDeEYsT0FBTyxJQUFJLENBQUM7U0FDYjtRQUNELE1BQU0sU0FBUyxHQUFHLElBQUksR0FBRyxDQUN2QixDQUFDLGlCQUFpQixJQUFJLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FB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