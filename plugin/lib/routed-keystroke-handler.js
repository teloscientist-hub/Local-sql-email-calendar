"use strict";
// routed-keystroke-handler.js
//
// Phase 5.5.1 — Cmd+Option+<letter> → move selected thread(s) into one of
// the `Routed/<name>` folders. Same move recipe as the existing
// disposition handler (Cmd+Shift+1..4): ChangeFolderTask for IMAP,
// ChangeLabelsTask for Gmail. Folder lookup by displayName, pre-created
// in Phase 5.
//
// Folder names below are GENERIC PLACEHOLDERS (Routed/A..H). Rename to
// your own folder names and keep keymaps/mml-routed.json + sidecar
// config.py ROUTING_FOLDERS + the routing prompt in sync.
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
    a: 'Routed/A',
    b: 'Routed/B',
    c: 'Routed/C',
    e: 'Routed/E',
    f: 'Routed/F',
    m: 'Routed/M',
    p: 'Routed/P',
    s: 'Routed/S',
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
        'Try Cmd+Option+A/B/C/E/F/M/P/S on a focused thread.');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGVkLWtleXN0cm9rZS1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3JvdXRlZC1rZXlzdHJva2UtaGFuZGxlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsOEJBQThCO0FBQzlCLEVBQUU7QUFDRiwwRUFBMEU7QUFDMUUsa0VBQWtFO0FBQ2xFLHdFQUF3RTtBQUN4RSwwRUFBMEU7QUFDMUUsaUNBQWlDO0FBQ2pDLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUsbUVBQW1FO0FBQ25FLHlFQUF5RTtBQUN6RSw2RUFBNkU7QUFDN0Usb0VBQW9FO0FBQ3BFLDREQUE0RDtBQUM1RCx5RUFBeUU7QUFDekUsd0NBQXdDOztBQUV4QywrREFBdUQ7QUFDdkQsMkRBQXlEO0FBRXpELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBRWxELE1BQU0sY0FBYyxHQUFHLHdCQUF3QixDQUFDO0FBRWhELE1BQU0sTUFBTSxHQUFHO0lBQ2IsSUFBSSxFQUFTLGFBQWE7SUFDMUIsYUFBYSxFQUFFLG9CQUFvQjtJQUNuQyxLQUFLLEVBQVEsY0FBYztJQUMzQixLQUFLLEVBQVEsY0FBYztJQUMzQixHQUFHLEVBQVUsWUFBWTtJQUN6QixNQUFNLEVBQU8sZUFBZTtJQUM1QixHQUFHLEVBQVUsWUFBWTtJQUN6QixHQUFHLEVBQVUsWUFBWTtDQUMxQixDQUFDO0FBRUYsSUFBSSxtQkFBbUIsR0FBRyxFQUFFLENBQUM7QUFFN0IsU0FBUyxhQUFhO0lBQ3BCLE9BQU8sd0NBQW1CLElBQUksd0NBQW1CLENBQUMsT0FBTztRQUN2RCxDQUFDLENBQUMsd0NBQW1CLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztRQUN2QyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ1gsQ0FBQztBQUVELEtBQUssVUFBVSxVQUFVLENBQUMsTUFBTTtJQUM5QixNQUFNLEdBQUcsR0FBRyxNQUFNLGFBQWEsQ0FBQyxlQUFlLENBQUMsTUFB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