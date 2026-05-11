"use strict";
// tag-keystroke-handler.js
//
// Phase 3 — Ctrl+Cmd+0..9 → manual rating. SILENT, INSTANT — no overlay,
// no prompt. The keymap (keymaps/mml-tags.json) maps these chords to
// commands like `mml-productivity:tag-5` which we register against
// document.body via AppEnv.commands.add.
//
// Grain: focused thread's most recent message (Phase 3 v0.1). The plan
// allows distinguishing single-message focus once Mailspring exposes the
// API; the README documents that limitation.
//
// Snapshot: we capture {rating, cluster_id} from whatever is currently
// rendered for the thread (sidecar-client cache lookup). On miss the
// snapshot fields are null — sidecar accepts that and stores nulls in
// system_rating_at_time / system_cluster_at_time.
Object.defineProperty(exports, "__esModule", { value: true });
const sidecarClient = require('./sidecar-client');
const { FocusedContentStore } = require('mailspring-exports');
const PLUGIN_VERSION = 'mml-productivity@0.2.0';
let _commandDisposables = [];
// ---------------------------------------------------------------------------
// Focus + RFC-822 ID resolution
function focusedThread() {
    return FocusedContentStore && FocusedContentStore.focused
        ? FocusedContentStore.focused('thread')
        : null;
}
async function focusedRfcMessageId(thread) {
    if (!thread)
        return null;
    const ids = await sidecarClient.rfcIdsForThread(thread);
    if (!ids || ids.length === 0)
        return null;
    // v0.1 grain: most recent message in the thread. rfcIdsForThread
    // returns Mailspring's natural order; we take the last entry as the
    // "most recent" — safe for the typical inbox case where messages are
    // appended chronologically.
    return ids[ids.length - 1];
}
// ---------------------------------------------------------------------------
// Snapshot from sidecar cache
async function snapshotForThread(thread) {
    // Best-effort: re-read whatever we recently rendered for this thread.
    // Returns { rating, cluster_id } with null fields on cache miss.
    const state = await sidecarClient.getThreadForMailspringThread(thread);
    if (!state)
        return { rating: null, cluster_id: null };
    return {
        rating: typeof state.rating === 'number' ? state.rating : null,
        cluster_id: typeof state.cluster_id === 'number' ? state.cluster_id : null,
    };
}
// ---------------------------------------------------------------------------
// Toast for transient feedback
function _toast(text, ms = 2200) {
    const original = document.title;
    document.title = `[mml] ${text}`;
    setTimeout(() => { document.title = original; }, ms);
}
// ---------------------------------------------------------------------------
// Main handler
async function tagFocused(rating) {
    const thread = focusedThread();
    if (!thread) {
        _toast('no thread focused');
        return;
    }
    const rfcId = await focusedRfcMessageId(thread);
    if (!rfcId) {
        _toast('no message-id for focused thread');
        return;
    }
    const snapshot = await snapshotForThread(thread);
    const result = await sidecarClient.rateMessage({
        rfc_message_id: rfcId,
        rating,
        note: null,
        what_i_saw_on_screen: snapshot,
        plugin_version: PLUGIN_VERSION,
    });
    if (!result) {
        _toast('sidecar unreachable');
        return;
    }
    if (result.error) {
        _toast(`tag failed: ${result.error}`);
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] /rate-message error:', result.error);
        return;
    }
    // Cache-bust so the badge re-renders with the new rating.
    const ids = await sidecarClient.rfcIdsForThread(thread);
    sidecarClient.bustThreadCache(ids);
    _toast(`tagged ${rating}${result.contact_rating_updated ? ' · contact updated' : ''}`);
}
// ---------------------------------------------------------------------------
// Command registration
const COMMAND_TO_RATING = {};
for (let n = 0; n <= 9; n++) {
    COMMAND_TO_RATING[`mml-productivity:tag-${n}`] = n;
}
function registerTagCommands() {
    for (const [name, rating] of Object.entries(COMMAND_TO_RATING)) {
        try {
            const d = AppEnv.commands.add(document.body, name, () => {
                // eslint-disable-next-line no-console
                console.info(`[mml-productivity] command fired: ${name} (rating=${rating})`);
                tagFocused(rating);
            });
            _commandDisposables.push(d);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[mml-productivity] failed to register ${name}:`, err);
        }
    }
    // eslint-disable-next-line no-console
    console.info(`[mml-productivity] registered ${_commandDisposables.length} tag commands. ` +
        'Try Ctrl+Cmd+0..9 on a focused thread.');
}
exports.registerTagCommands = registerTagCommands;
function unregisterTagCommands() {
    for (const d of _commandDisposables) {
        try {
            if (d && d.dispose)
                d.dispose();
        }
        catch (_e) { /* noop */ }
    }
    _commandDisposables = [];
}
exports.unregisterTagCommands = unregisterTagCommands;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGFnLWtleXN0cm9rZS1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3RhZy1rZXlzdHJva2UtaGFuZGxlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsMkJBQTJCO0FBQzNCLEVBQUU7QUFDRix5RUFBeUU7QUFDekUscUVBQXFFO0FBQ3JFLG1FQUFtRTtBQUNuRSx5Q0FBeUM7QUFDekMsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSx5RUFBeUU7QUFDekUsNkNBQTZDO0FBQzdDLEVBQUU7QUFDRix1RUFBdUU7QUFDdkUscUVBQXFFO0FBQ3JFLHNFQUFzRTtBQUN0RSxrREFBa0Q7O0FBRWxELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBRWxELE1BQU0sRUFBRSxtQkFBbUIsRUFBRSxHQUFHLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0FBRTlELE1BQU0sY0FBYyxHQUFHLHdCQUF3QixDQUFDO0FBRWhELElBQUksbUJBQW1CLEdBQUcsRUFBRSxDQUFDO0FBRTdCLDhFQUE4RTtBQUM5RSxnQ0FBZ0M7QUFFaEMsU0FBUyxhQUFhO0lBQ3BCLE9BQU8sbUJBQW1CLElBQUksbUJBQW1CLENBQUMsT0FBTztRQUN2RCxDQUFDLENBQUMsbUJBQW1CLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztRQUN2QyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ1gsQ0FBQztBQUVELEtBQUssVUFBVSxtQkFBbUIsQ0FBQyxNQUFNO0lBQ3ZDLElBQUksQ0FBQyxNQUFNO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDekIsTUFBTSxHQUFHLEdBQUcsTUFBTSxhQUFhLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hELElBQUksQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDMUMsaUVBQWlFO0lBQ2pFLG9FQUFvRTtJQUNwRSxxRUFBcUU7SUFDckUsNEJBQTRCO0lBQzVCLE9BQU8sR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDN0IsQ0FBQztBQUVELDhFQUE4RTtBQUM5RSw4QkFBOEI7QUFFOUIsS0FBSyxVQUFVLGlCQUFpQixDQUFDLE1BQU07SUFDckMsc0VBQXNFO0lBQ3RFLGlFQUFpRTtJQUNqRSxNQUFNLEtBQUssR0FBRyxNQUFNLGFBQWEsQ0FBQyw0QkFBNEIsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsS0FBSztRQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUN0RCxPQUFPO1FBQ0wsTUFBTSxFQUFFLE9BQU8sS0FBSyxDQUFDLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUk7UUFDOUQsVUFBVSxFQUFFLE9BQU8sS0FBSyxDQUFDLFVBQVUsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLElBQUk7S0FDM0UsQ0FBQztBQUNKLENBQUM7QUFFRCw4RUFBOEU7QUFDOUUsK0JBQStCO0FBRS9CLFNBQVMsTUFBTSxDQUFDLElBQUksRUFBRSxFQUFFLEdBQUcsSUFBSTtJQUM3QixNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDO0lBQ2hDLFFBQVEsQ0FBQyxLQUFLLEdBQUcsU0FBUyxJQUFJLEVBQUUsQ0FBQztJQUNqQyxVQUFVLENBQUMsR0FBRyxFQUFFLEdBQUcsUUFBUSxDQUFDLEtBQUssR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDdkQsQ0FBQztBQUVELDhFQUE4RTtBQUM5RSxlQUFlO0FBRWYsS0FBSyxVQUFVLFVBQVUsQ0FBQyxNQUFNO0lBQzlCLE1BQU0sTUFBTSxHQUFHLGFBQWEsRUFBRSxDQUFDO0lBQy9CLElBQUksQ0FBQyxNQUFNLEVBQUU7UUFDWCxNQUFNLENBQUMsbUJBQW1CLENBQUMsQ0FBQztRQUM1QixPQUFPO0tBQ1I7SUFDRCxNQUFNLEtBQUssR0FBRyxNQUFNLG1CQUFtQixDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxLQUFLLEVBQUU7UUFDVixNQUFNLENBQUMsa0NBQWtDLENBQUMsQ0FBQztRQUMzQyxPQUFPO0tBQ1I7SUFDRCxNQUFNLFFBQVEsR0FBRyxNQUFNLGlCQUFpQixDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2pELE1BQU0sTUFBTSxHQUFHLE1BQU0sYUFBYSxDQUFDLFdBQVcsQ0FBQztRQUM3QyxjQUFjLEVBQUUsS0FBSztRQUNyQixNQUFNO1FBQ04sSUFBSSxFQUFFLElBQUk7UUFDVixvQkFBb0IsRUFBRSxRQUFRO1FBQzlCLGNBQWMsRUFBRSxjQUFjO0tBQy9CLENBQUMsQ0FBQztJQUNILElBQUksQ0FBQyxNQUFNLEVBQUU7UUFDWCxNQUFNLENBQUMscUJBQXFCLENBQUMsQ0FBQztRQUM5QixPQUFPO0tBQ1I7SUFDRCxJQUFJLE1BQU0sQ0FBQyxLQUFLLEVBQUU7UUFDaEIsTUFBTSxDQUFDLGVBQWUsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDdEMsc0NBQXNDO1FBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMseUNBQXlDLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3RFLE9BQU87S0FDUjtJQUNELDBEQUEwRDtJQUMxRCxNQUFNLEdBQUcsR0FBRyxNQUFNLGFBQWEsQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDeEQsYUFBYSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNuQyxNQUFNLENBQUMsVUFBVSxNQUFNLEdBQUcsTUFBTSxDQUFDLHNCQUFzQixDQUFDLENBQUMsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztBQUN6RixDQUFDO0FBRUQsOEVBQThFO0FBQzlFLHVCQUF1QjtBQUV2QixNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztBQUM3QixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFO0lBQzNCLGlCQUFpQixDQUFDLHdCQUF3QixDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQztDQUNwRDtBQUVELFNBQWdCLG1CQUFtQjtJQUNqQyxLQUFLLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsQ0FBQyxFQUFFO1FBQzlELElBQUk7WUFDRixNQUFNLENBQUMsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUU7Z0JBQ3RELHNDQUFzQztnQkFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyxxQ0FBcUMsSUFBSSxZQUFZLE1BQU0sR0FBRyxDQUFDLENBQUM7Z0JBQzdFLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUNyQixDQUFDLENBQUMsQ0FBQztZQUNILG1CQUFtQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztTQUM3QjtRQUFDLE9BQU8sR0FBRyxFQUFFO1lBQ1osc0NBQXNDO1lBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMseUNBQXlDLElBQUksR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1NBQ3JFO0tBQ0Y7SUFDRCxzQ0FBc0M7SUFDdEMsT0FBTyxDQUFDLElBQUksQ0FDVixpQ0FBaUMsbUJBQW1CLENBQUMsTUFBTSxpQkFBaUI7UUFDNUUsd0NBQXdDLENBQ3pDLENBQUM7QUFDSixDQUFDO0FBbkJELGtEQW1CQztBQUVELFNBQWdCLHFCQUFxQjtJQUNuQyxLQUFLLE1BQU0sQ0FBQyxJQUFJLG1CQUFtQixFQUFFO1FBQ25DLElBQUk7WUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsT0FBTztnQkFBRSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUM7U0FBRTtRQUFDLE9BQU8sRUFBRSxFQUFFLEVBQUUsVUFBVSxFQUFFO0tBQ25FO0lBQ0QsbUJBQW1CLEdBQUcsRUFBRSxDQUFDO0FBQzNCLENBQUM7QUFMRCxzREFLQyJ9