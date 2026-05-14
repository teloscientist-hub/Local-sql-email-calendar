"use strict";
// routed-keystroke-handler.js
//
// Phase 5.5.1 — Cmd+Option+<letter> → move selected thread(s) into one of
// the 8 `Routed/<name>` folders. Same move recipe as the existing
// disposition handler (Cmd+Shift+1..4): ChangeFolderTask for IMAP/Zoho,
// ChangeLabelsTask for Gmail. Folder lookup by displayName ('Routed/aol7'
// etc.), pre-created in Phase 5.
//
// Phase 5.5.2 — each press also logs a routing_corrections row to the
// sidecar so corrections become training signal. Source semantics:
//   * 'accept'   — a cached LLM suggestion (from a prior Cmd+Option+Y on
//                  the same thread, this session) matched the chosen letter.
//   * 'override' — a cached LLM suggestion existed but pointed to a
//                  different folder than the letter chosen.
//   * 'manual'   — no cached suggestion (the common case until a chip is
//                  added to the badge).
Object.defineProperty(exports, "__esModule", { value: true });
const disposition_actions_1 = require("./disposition-actions");
const mailspring_exports_1 = require("mailspring-exports");
const sidecarClient = require('./sidecar-client');
const PLUGIN_VERSION = 'mml-productivity@0.2.0';
const ROUTES = {
    ai: 'Routed/AI',
    aol7: 'Routed/aol7',
    'coach-sales': 'Routed/coach sales',
    deals: 'Routed/deals',
    entertaining: 'Routed/entertaining',
    finance: 'Routed/Finance',
    models: 'Routed/models',
    pol: 'Routed/pol',
    smm: 'Routed/smm',
    'tech-noise': 'Routed/Tech Noise',
    wellness: 'Routed/Wellness',
};
let _commandDisposables = [];
function focusedThread() {
    return mailspring_exports_1.FocusedContentStore && mailspring_exports_1.FocusedContentStore.focused
        ? mailspring_exports_1.FocusedContentStore.focused('thread')
        : null;
}
async function _lastRfcId(thread) {
    const ids = await sidecarClient.rfcIdsForThread(thread);
    if (!ids || ids.length === 0)
        return null;
    return ids[ids.length - 1];
}
async function routeToFolder(folderName) {
    const thread = focusedThread();
    // Pull the cached LLM suggestion (if any) BEFORE moving — used to label
    // the correction with the right source. Cache-only: no LLM trigger here.
    let cachedSuggestion = null;
    let rfcId = null;
    if (thread) {
        rfcId = await _lastRfcId(thread);
        cachedSuggestion = await sidecarClient.getCachedRouteSuggestionForThread(thread);
    }
    // Run the move. moveSelectedTo handles multi-select selection itself; we
    // pass `[thread]` only as a fallback when no selection exists.
    const result = disposition_actions_1.moveSelectedTo(folderName, thread ? [thread] : []);
    if (!result || result.queued === 0) {
        return;
    }
    // Decide source. cachedSuggestion is non-null only if the user pressed
    // Cmd+Option+Y on this thread earlier in the same session.
    let source = 'manual';
    let suggestedForLog = null;
    if (cachedSuggestion && cachedSuggestion.suggested_folder) {
        suggestedForLog = cachedSuggestion.suggested_folder;
        source = (suggestedForLog === folderName) ? 'accept' : 'override';
    }
    // Fire-and-record. Only meaningful if we have an rfcId.
    if (rfcId) {
        sidecarClient.routeCorrection({
            rfc_message_id: rfcId,
            suggested_folder: suggestedForLog,
            accepted_folder: folderName,
            source,
            plugin_version: PLUGIN_VERSION,
        }).then((res) => {
            if (res && res.error) {
                // eslint-disable-next-line no-console
                console.warn(`[mml-productivity] /route-correction (${source}) error:`, res.error);
            }
        });
    }
}
function registerRoutedCommands() {
    for (const [suffix, folderName] of Object.entries(ROUTES)) {
        const commandName = `mml-productivity:route-to-${suffix}`;
        try {
            const d = AppEnv.commands.add(document.body, commandName, () => {
                // eslint-disable-next-line no-console
                console.info(`[mml-productivity] route command fired: ${commandName} → ${folderName}`);
                routeToFolder(folderName);
            });
            _commandDisposables.push(d);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[mml-productivity] failed to register ${commandName}:`, err);
        }
    }
    // eslint-disable-next-line no-console
    console.info(`[mml-productivity] registered ${_commandDisposables.length} routed commands. ` +
        'Try Cmd+Option+A/B/C/E/F/H/M/P/S/W/X on a focused thread.');
}
exports.registerRoutedCommands = registerRoutedCommands;
function unregisterRoutedCommands() {
    for (const d of _commandDisposables) {
        try {
            if (d && d.dispose)
                d.dispose();
        }
        catch (_e) { /* noop */ }
    }
    _commandDisposables = [];
}
exports.unregisterRoutedCommands = unregisterRoutedCommands;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGVkLWtleXN0cm9rZS1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3JvdXRlZC1rZXlzdHJva2UtaGFuZGxlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsOEJBQThCO0FBQzlCLEVBQUU7QUFDRiwwRUFBMEU7QUFDMUUsa0VBQWtFO0FBQ2xFLHdFQUF3RTtBQUN4RSwwRUFBMEU7QUFDMUUsaUNBQWlDO0FBQ2pDLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUsbUVBQW1FO0FBQ25FLHlFQUF5RTtBQUN6RSw2RUFBNkU7QUFDN0Usb0VBQW9FO0FBQ3BFLDREQUE0RDtBQUM1RCx5RUFBeUU7QUFDekUsd0NBQXdDOztBQUV4QywrREFBdUQ7QUFDdkQsMkRBQXlEO0FBRXpELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBRWxELE1BQU0sY0FBYyxHQUFHLHdCQUF3QixDQUFDO0FBRWhELE1BQU0sTUFBTSxHQUFHO0lBQ2IsRUFBRSxFQUFjLFdBQVc7SUFDM0IsSUFBSSxFQUFZLGFBQWE7SUFDN0IsYUFBYSxFQUFHLG9CQUFvQjtJQUNwQyxLQUFLLEVBQVcsY0FBYztJQUM5QixZQUFZLEVBQUkscUJBQXFCO0lBQ3JDLE9BQU8sRUFBUyxnQkFBZ0I7SUFDaEMsTUFBTSxFQUFVLGVBQWU7SUFDL0IsR0FBRyxFQUFhLFlBQVk7SUFDNUIsR0FBRyxFQUFhLFlBQVk7SUFDNUIsWUFBWSxFQUFJLG1CQUFtQjtJQUNuQyxZQUFZLEVBQUkscUJBQXFCO0NBQ3RDLENBQUM7QUFFRixJQUFJLG1CQUFtQixHQUFHLEVBQUUsQ0FBQztBQUU3QixTQUFTLGFBQWE7SUFDcEIsT0FBTyx3Q0FBbUIsSUFBSSx3Q0FBbUIsQ0FBQyxPQUFPO1FBQ3ZELENBQUMsQ0FBQyx3Q0FBbUIsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDWCxDQUFDO0FBRUQsS0FB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