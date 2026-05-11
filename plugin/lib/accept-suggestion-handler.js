"use strict";
// accept-suggestion-handler.js
//
// Phase 5.5.4 — Cmd+Option+Y opens the route-confirm overlay. The overlay
// (route-confirm-overlay.jsx) handles classification, display, and the
// confirm/override/cancel keystrokes. This module is now a thin trigger
// only — no direct moves, no direct correction logging.
Object.defineProperty(exports, "__esModule", { value: true });
const sidecarClient = require('./sidecar-client');
const { openRouteConfirmOverlay } = require('./route-confirm-overlay');
const { FocusedContentStore } = require('mailspring-exports');
const COMMAND_NAME = 'mml-productivity:accept-suggestion';
let _disposable = null;
function focusedThread() {
    return FocusedContentStore && FocusedContentStore.focused
        ? FocusedContentStore.focused('thread')
        : null;
}
function _toast(text, ms = 2200) {
    const original = document.title;
    document.title = `[mml] ${text}`;
    setTimeout(() => { document.title = original; }, ms);
}
async function openOverlayForFocused() {
    const thread = focusedThread();
    if (!thread) {
        _toast('no thread focused');
        return;
    }
    const ids = await sidecarClient.rfcIdsForThread(thread);
    if (!ids || ids.length === 0) {
        _toast('no message-id for thread');
        return;
    }
    const rfcId = ids[ids.length - 1];
    openRouteConfirmOverlay(thread, rfcId);
}
function registerAcceptCommand() {
    if (_disposable)
        return;
    try {
        _disposable = AppEnv.commands.add(document.body, COMMAND_NAME, () => {
            // eslint-disable-next-line no-console
            console.info(`[mml-productivity] command fired: ${COMMAND_NAME}`);
            openOverlayForFocused().catch((err) => {
                // eslint-disable-next-line no-console
                console.warn('[mml-productivity] accept-suggestion threw:', err);
            });
        });
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] accept-suggestion ready (Cmd+Option+Y).');
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[mml-productivity] failed to register ${COMMAND_NAME}:`, err);
    }
}
exports.registerAcceptCommand = registerAcceptCommand;
function unregisterAcceptCommand() {
    if (_disposable && _disposable.dispose) {
        try {
            _disposable.dispose();
        }
        catch (_e) { /* noop */ }
    }
    _disposable = null;
}
exports.unregisterAcceptCommand = unregisterAcceptCommand;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWNjZXB0LXN1Z2dlc3Rpb24taGFuZGxlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9hY2NlcHQtc3VnZ2VzdGlvbi1oYW5kbGVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSwrQkFBK0I7QUFDL0IsRUFBRTtBQUNGLDBFQUEwRTtBQUMxRSx1RUFBdUU7QUFDdkUsd0VBQXdFO0FBQ3hFLHdEQUF3RDs7QUFFeEQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDbEQsTUFBTSxFQUFFLHVCQUF1QixFQUFFLEdBQUcsT0FBTyxDQUFDLHlCQUF5QixDQUFDLENBQUM7QUFDdkUsTUFBTSxFQUFFLG1CQUFtQixFQUFFLEdBQUcsT0FBTyxDQUFDLG9CQUFvQixDQUFDLENBQUM7QUFFOUQsTUFBTSxZQUFZLEdBQUcsb0NBQW9DLENBQUM7QUFFMUQsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBRXZCLFNBQVMsYUFBYTtJQUNwQixPQUFPLG1CQUFtQixJQUFJLG1CQUFtQixDQUFDLE9BQU87UUFDdkQsQ0FBQyxDQUFDLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUM7UUFDdkMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNYLENBQUM7QUFFRCxTQUFTLE1BQU0sQ0FBQyxJQUFJLEVBQUUsRUFBRSxHQUFHLElBQUk7SUFDN0IsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQztJQUNoQyxRQUFRLENBQUMsS0FBSyxHQUFHLFNBQVMsSUFBSSxFQUFFLENBQUM7SUFDakMsVUFBVSxDQUFDLEdBQUcsRUFBRSxHQUFHLFFBQVEsQ0FBQyxLQUFLLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ3ZELENBQUM7QUFFRCxLQUFLLFVBQVUscUJBQXFCO0lBQ2xDLE1BQU0sTUFBTSxHQUFHLGFBQWEsRUFBRSxDQUFDO0lBQy9CLElBQUksQ0FBQyxNQUFNLEVBQUU7UUFDWCxNQUFNLENBQUMsbUJBQW1CLENBQUMsQ0FBQztRQUM1QixPQUFPO0tBQ1I7SUFDRCxNQUFNLEdBQUcsR0FBRyxNQUFNLGFBQWEsQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDeEQsSUFBSSxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRTtRQUM1QixNQUFNLENBQUMsMEJBQTBCLENBQUMsQ0FBQztRQUNuQyxPQUFPO0tBQ1I7SUFDRCxNQUFNLEtBQUssR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQztJQUNsQyx1QkFBdUIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDekMsQ0FBQztBQUVELFNBQWdCLHFCQUFxQjtJQUNuQyxJQUFJLFdBQVc7UUFBRSxPQUFPO0lBQ3hCLElBQUk7UUFDRixXQUFXLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUUsR0FBRyxFQUFFO1lBQ2xFLHNDQUFzQztZQUN0QyxPQUFPLENBQUMsSUFBSSxDQUFDLHFDQUFxQyxZQUFZLEVBQUUsQ0FBQyxDQUFDO1lBQ2xFLHFCQUFxQixFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxFQUFFLEVBQUU7Z0JBQ3BDLHNDQUFzQztnQkFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyw2Q0FBNkMsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUNuRSxDQUFDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBQ0gsc0NBQXNDO1FBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMsNERBQTRELENBQUMsQ0FBQztLQUM1RTtJQUFDLE9BQU8sR0FBRyxFQUFFO1FBQ1osc0NBQXNDO1FBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMseUNBQXlDLFlBQVksR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0tBQzdFO0FBQ0gsQ0FBQztBQWpCRCxzREFpQkM7QUFFRCxTQUFnQix1QkFBdUI7SUFDckMsSUFBSSxXQUFXLElBQUksV0FBVyxDQUFDLE9BQU8sRUFBRTtRQUN0QyxJQUFJO1lBQUUsV0FBVyxDQUFDLE9BQU8sRUFBRSxDQUFDO1NBQUU7UUFBQyxPQUFPLEVBQUUsRUFBRSxFQUFFLFVBQVUsRUFBRTtLQUN6RDtJQUNELFdBQVcsR0FBRyxJQUFJLENBQUM7QUFDckIsQ0FBQztBQUxELDBEQUtDIn0=