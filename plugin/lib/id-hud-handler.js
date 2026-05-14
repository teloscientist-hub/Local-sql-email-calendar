"use strict";
// id-hud-handler.js
//
// Right-click on a thread row → open the debug ID HUD overlay listing
// every RFC-822 Message-ID + warehouse id for the thread.
//
// Detection: every Mailspring thread-list row has id="list-item-<threadId>"
// (multiselect-list.js:194, constant across split/list layouts — see
// sort-view-overlay.jsx:429). We walk up from event.target to find that
// element, extract the threadId, and resolve via sidecarClient.
//
// We don't preventDefault unconditionally — only when we find a row.
// Right-click anywhere else (compose, sidebar, etc.) falls through to
// the platform / Mailspring context menu.
Object.defineProperty(exports, "__esModule", { value: true });
const sidecarClient = require('./sidecar-client');
const { openIdHudOverlay } = require('./id-hud-overlay');
let _listener = null;
function _findRowThreadId(target) {
    let el = target;
    while (el && el !== document.body) {
        if (el.id && typeof el.id === 'string' && el.id.indexOf('list-item-') === 0) {
            return el.id.slice('list-item-'.length);
        }
        el = el.parentElement;
    }
    return null;
}
async function _openHudForThreadId(threadId) {
    // rfcIdsForThread only needs `.id` — the cache lookup keys on it and the
    // DB fallback queries by threadId. We don't need the full Thread model.
    let ids = [];
    try {
        ids = await sidecarClient.rfcIdsForThread({ id: threadId });
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] id-hud: rfcIdsForThread failed', err);
    }
    if (!ids || ids.length === 0) {
        // Still open the HUD with an empty-ish payload so the user gets feedback.
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] id-hud: no rfc ids for thread', threadId);
        return;
    }
    let lookup = null;
    try {
        lookup = await sidecarClient.messageLookup(ids);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] id-hud: messageLookup failed', err);
    }
    const rows = (lookup && Array.isArray(lookup.messages)) ? lookup.messages : [];
    openIdHudOverlay(ids, rows);
}
function _onContextMenu(e) {
    const threadId = _findRowThreadId(e.target);
    if (!threadId)
        return;
    e.preventDefault();
    e.stopPropagation();
    _openHudForThreadId(threadId);
}
function registerIdHud() {
    if (_listener)
        return;
    _listener = _onContextMenu;
    // Capture so we win against Mailspring's own contextmenu wiring.
    document.addEventListener('contextmenu', _listener, true);
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] id-hud: right-click handler registered.');
}
exports.registerIdHud = registerIdHud;
function unregisterIdHud() {
    if (!_listener)
        return;
    document.removeEventListener('contextmenu', _listener, true);
    _listener = null;
}
exports.unregisterIdHud = unregisterIdHud;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWQtaHVkLWhhbmRsZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaWQtaHVkLWhhbmRsZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLG9CQUFvQjtBQUNwQixFQUFFO0FBQ0Ysc0VBQXNFO0FBQ3RFLDBEQUEwRDtBQUMxRCxFQUFFO0FBQ0YsNEVBQTRFO0FBQzVFLHFFQUFxRTtBQUNyRSx3RUFBd0U7QUFDeEUsZ0VBQWdFO0FBQ2hFLEVBQUU7QUFDRixxRUFBcUU7QUFDckUsc0VBQXNFO0FBQ3RFLDBDQUEwQzs7QUFFMUMsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDbEQsTUFBTSxFQUFFLGdCQUFnQixFQUFFLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFFekQsSUFBSSxTQUFTLEdBQUcsSUFBSSxDQUFDO0FBRXJCLFNBQVMsZ0JBQWdCLENBQUMsTUFBTTtJQUM5QixJQUFJLEVBQUUsR0FBRyxNQUFNLENBQUM7SUFDaEIsT0FBTyxFQUFFLElBQUksRUFBRSxLQUFLLFFBQVEsQ0FBQyxJQUFJLEVBQUU7UUFDakMsSUFBSSxFQUFFLENBQUMsRUFBRSxJQUFJLE9BQU8sRUFBRSxDQUFDLEVBQUUsS0FBSyxRQUFRLElBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxFQUFFO1lBQzNFLE9BQU8sRUFBRSxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1NBQ3pDO1FBQ0QsRUFBRSxHQUFHLEVBQUUsQ0FBQyxhQUFhLENBQUM7S0FDdkI7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNkLENBQUM7QUFFRCxLQUFLLFVBQVUsbUJBQW1CLENBQUMsUUFBUTtJQUN6Qyx5RUFBeUU7SUFDekUsd0VBQXdFO0lBQ3hFLElBQUksR0FBRyxHQUFHLEVBQUUsQ0FBQztJQUNiLElBQUk7UUFDRixHQUFHLEdBQUcsTUFBTSxhQUFhLENBQUMsZUFBZSxDQUFDLEVBQUUsRUFBRSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUM7S0FDN0Q7SUFBQyxPQUFPLEdBQUcsRUFBRTtRQUNaLHNDQUFzQztRQUN0QyxPQUFPLENBQUMsSUFBSSxDQUFDLG1EQUFtRCxFQUFFLEdBQUcsQ0FBQyxDQUFDO0tBQ3hFO0lBQ0QsSUFBSSxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRTtRQUM1QiwwRUFBMEU7UUFDMUUsc0NBQXNDO1FBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMsa0RBQWtELEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDM0UsT0FBTztLQUNSO0lBRUQsSUFBSSxNQUFNLEdBQUcsSUFBSSxDQUFDO0lBQ2xCLElBQUk7UUFDRixNQUFNLEdBQUcsTUFBTSxhQUFhLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0tBQ2pEO0lBQUMsT0FBTyxHQUFHLEVBQUU7UUFDWixzQ0FBc0M7UUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyxpREFBaUQsRUFBRSxHQUFHLENBQUMsQ0FBQztLQUN0RTtJQUNELE1BQU0sSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUMvRSxnQkFBZ0IsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDOUIsQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLENBQUM7SUFDdkIsTUFBTSxRQUFRLEdBQUcsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzVDLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTztJQUN0QixDQUFDLENBQUMsY0FBYyxFQUFFLENBQUM7SUFDbkIsQ0FBQyxDQUFDLGVBQWUsRUFBRSxDQUFDO0lBQ3BCLG1CQUFtQixDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ2hDLENBQUM7QUFFRCxTQUFnQixhQUFhO0lBQzNCLElBQUksU0FBUztRQUFFLE9BQU87SUFDdEIsU0FBUyxHQUFHLGNBQWMsQ0FBQztJQUMzQixpRUFBaUU7SUFDakUsUUFBUSxDQUFDLGdCQUFnQixDQUFDLGFBQWEsRUFBRSxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDMUQsc0NBQXNDO0lBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMsNERBQTRELENBQUMsQ0FBQztBQUM3RSxDQUFDO0FBUEQsc0NBT0M7QUFFRCxTQUFnQixlQUFlO0lBQzdCLElBQUksQ0FBQyxTQUFTO1FBQUUsT0FBTztJQUN2QixRQUFRLENBQUMsbUJBQW1CLENBQUMsYUFBYSxFQUFFLFNBQVMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUM3RCxTQUFTLEdBQUcsSUFBSSxDQUFDO0FBQ25CLENBQUM7QUFKRCwwQ0FJQyJ9