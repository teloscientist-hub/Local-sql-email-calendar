"use strict";
// event-keystroke-handler.js
//
// Phase 5 — Ctrl+Cmd+E → open the event-input overlay for the focused
// thread's latest message. The overlay handles its own LLM draft fetch
// via /draft-event in the background and the submit via /create-event.
//
// Grain: focused thread's most recent message (same rule as Ctrl+Cmd+N).
Object.defineProperty(exports, "__esModule", { value: true });
const sidecarClient = require('./sidecar-client');
const { openEventOverlay } = require('./event-input-overlay');
const { FocusedContentStore } = require('mailspring-exports');
let _disposable = null;
function _toast(text, ms = 2200) {
    const original = document.title;
    document.title = `[mml] ${text}`;
    setTimeout(() => { document.title = original; }, ms);
}
async function openForFocused() {
    const thread = FocusedContentStore && FocusedContentStore.focused
        ? FocusedContentStore.focused('thread')
        : null;
    if (!thread) {
        _toast('no thread focused');
        return;
    }
    const ids = await sidecarClient.rfcIdsForThread(thread);
    if (!ids || ids.length === 0) {
        _toast('no message-id for focused thread');
        return;
    }
    const rfcId = ids[ids.length - 1];
    openEventOverlay(rfcId);
}
function registerEventCommand() {
    try {
        _disposable = AppEnv.commands.add(document.body, 'mml-productivity:create-event', () => {
            // eslint-disable-next-line no-console
            console.info('[mml-productivity] command fired: mml-productivity:create-event');
            openForFocused();
        });
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] registered create-event command. Try Ctrl+Cmd+E on a focused thread.');
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] failed to register create-event command:', err);
    }
}
exports.registerEventCommand = registerEventCommand;
function unregisterEventCommand() {
    if (_disposable && _disposable.dispose) {
        try {
            _disposable.dispose();
        }
        catch (_e) { /* noop */ }
    }
    _disposable = null;
}
exports.unregisterEventCommand = unregisterEventCommand;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnQta2V5c3Ryb2tlLWhhbmRsZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZXZlbnQta2V5c3Ryb2tlLWhhbmRsZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLDZCQUE2QjtBQUM3QixFQUFFO0FBQ0Ysc0VBQXNFO0FBQ3RFLHVFQUF1RTtBQUN2RSx1RUFBdUU7QUFDdkUsRUFBRTtBQUNGLHlFQUF5RTs7QUFFekUsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDbEQsTUFBTSxFQUFFLGdCQUFnQixFQUFFLEdBQUcsT0FBTyxDQUFDLHVCQUF1QixDQUFDLENBQUM7QUFFOUQsTUFBTSxFQUFFLG1CQUFtQixFQUFFLEdBQUcsT0FBTyxDQUFDLG9CQUFvQixDQUFDLENBQUM7QUFFOUQsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBRXZCLFNBQVMsTUFBTSxDQUFDLElBQUksRUFBRSxFQUFFLEdBQUcsSUFBSTtJQUM3QixNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDO0lBQ2hDLFFBQVEsQ0FBQyxLQUFLLEdBQUcsU0FBUyxJQUFJLEVBQUUsQ0FBQztJQUNqQyxVQUFVLENBQUMsR0FBRyxFQUFFLEdBQUcsUUFBUSxDQUFDLEtBQUssR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDdkQsQ0FBQztBQUVELEtBQUssVUFBVSxjQUFjO0lBQzNCLE1BQU0sTUFBTSxHQUFHLG1CQUFtQixJQUFJLG1CQUFtQixDQUFDLE9BQU87UUFDL0QsQ0FBQyxDQUFDLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUM7UUFDdkMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNULElBQUksQ0FBQyxNQUFNLEVBQUU7UUFDWCxNQUFNLENBQUMsbUJBQW1CLENBQUMsQ0FBQztRQUM1QixPQUFPO0tBQ1I7SUFDRCxNQUFNLEdBQUcsR0FBRyxNQUFNLGFBQWEsQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDeEQsSUFBSSxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRTtRQUM1QixNQUFNLENBQUMsa0NBQWtDLENBQUMsQ0FBQztRQUMzQyxPQUFPO0tBQ1I7SUFDRCxNQUFNLEtBQUssR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQztJQUNsQyxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUMxQixDQUFDO0FBRUQsU0FBZ0Isb0JBQW9CO0lBQ2xDLElBQUk7UUFDRixXQUFXLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQy9CLFFBQVEsQ0FBQyxJQUFJLEVBQ2IsK0JBQStCLEVBQy9CLEdBQUcsRUFBRTtZQUNILHNDQUFzQztZQUN0QyxPQUFPLENBQUMsSUFBSSxDQUFDLGlFQUFpRSxDQUFDLENBQUM7WUFDaEYsY0FBYyxFQUFFLENBQUM7UUFDbkIsQ0FBQyxDQUNGLENBQUM7UUFDRixzQ0FBc0M7UUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyx5RkFBeUYsQ0FBQyxDQUFDO0tBQ3pHO0lBQUMsT0FBTyxHQUFHLEVBQUU7UUFDWixzQ0FBc0M7UUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyw2REFBNkQsRUFBRSxHQUFHLENBQUMsQ0FBQztLQUNsRjtBQUNILENBQUM7QUFqQkQsb0RBaUJDO0FBRUQsU0FBZ0Isc0JBQXNCO0lBQ3BDLElBQUksV0FBVyxJQUFJLFdBQVcsQ0FBQyxPQUFPLEVBQUU7UUFDdEMsSUFBSTtZQUFFLFdBQVcsQ0FBQyxPQUFPLEVBQUUsQ0FBQztTQUFFO1FBQUMsT0FBTyxFQUFFLEVBQUUsRUFBRSxVQUFVLEVBQUU7S0FDekQ7SUFDRCxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3JCLENBQUM7QUFMRCx3REFLQyJ9