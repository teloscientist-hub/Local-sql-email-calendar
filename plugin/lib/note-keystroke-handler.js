"use strict";
// note-keystroke-handler.js
//
// Phase 3 — Ctrl+Cmd+N → open the note-input overlay for the focused
// thread's latest message. The overlay handles Esc / Enter and POSTs
// to /add-note. The overlay errors-inline if no rating row exists yet
// for the focused message (plugin v0.1 doesn't auto-create one — the owner
// can hit Ctrl+Cmd+0..9 first).
Object.defineProperty(exports, "__esModule", { value: true });
const sidecarClient = require('./sidecar-client');
const { openNoteOverlay } = require('./note-input-overlay');
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
    openNoteOverlay(rfcId);
}
function registerNoteCommand() {
    try {
        _disposable = AppEnv.commands.add(document.body, 'mml-productivity:add-note', () => {
            // eslint-disable-next-line no-console
            console.info('[mml-productivity] command fired: mml-productivity:add-note');
            openForFocused();
        });
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] registered note command. Try Ctrl+Cmd+N on a focused thread.');
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] failed to register note command:', err);
    }
}
exports.registerNoteCommand = registerNoteCommand;
function unregisterNoteCommand() {
    if (_disposable && _disposable.dispose) {
        try {
            _disposable.dispose();
        }
        catch (_e) { /* noop */ }
    }
    _disposable = null;
}
exports.unregisterNoteCommand = unregisterNoteCommand;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibm90ZS1rZXlzdHJva2UtaGFuZGxlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9ub3RlLWtleXN0cm9rZS1oYW5kbGVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSw0QkFBNEI7QUFDNUIsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSxxRUFBcUU7QUFDckUsc0VBQXNFO0FBQ3RFLHNFQUFzRTtBQUN0RSxnQ0FBZ0M7O0FBRWhDLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQ2xELE1BQU0sRUFBRSxlQUFlLEVBQUUsR0FBRyxPQUFPLENBQUMsc0JBQXNCLENBQUMsQ0FBQztBQUU1RCxNQUFNLEVBQUUsbUJBQW1CLEVBQUUsR0FBRyxPQUFPLENBQUMsb0JBQW9CLENBQUMsQ0FBQztBQUU5RCxJQUFJLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFFdkIsU0FBUyxNQUFNLENBQUMsSUFBSSxFQUFFLEVBQUUsR0FBRyxJQUFJO0lBQzdCLE1BQU0sUUFBUSxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUM7SUFDaEMsUUFBUSxDQUFDLEtBQUssR0FBRyxTQUFTLElBQUksRUFBRSxDQUFDO0lBQ2pDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxRQUFRLENBQUMsS0FBSyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztBQUN2RCxDQUFDO0FBRUQsS0FBSyxVQUFVLGNBQWM7SUFDM0IsTUFBTSxNQUFNLEdBQUcsbUJBQW1CLElBQUksbUJBQW1CLENBQUMsT0FBTztRQUMvRCxDQUFDLENBQUMsbUJBQW1CLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztRQUN2QyxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQ1QsSUFBSSxDQUFDLE1BQU0sRUFBRTtRQUNYLE1BQU0sQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1FBQzVCLE9BQU87S0FDUjtJQUNELE1BQU0sR0FBRyxHQUFHLE1BQU0sYUFBYSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4RCxJQUFJLENBQUMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFO1FBQzVCLE1BQU0sQ0FBQyxrQ0FBa0MsQ0FBQyxDQUFDO1FBQzNDLE9BQU87S0FDUjtJQUNELE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ2xDLGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsU0FBZ0IsbUJBQW1CO0lBQ2pDLElBQUk7UUFDRixXQUFXLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQy9CLFFBQVEsQ0FBQyxJQUFJLEVBQ2IsMkJBQTJCLEVBQzNCLEdBQUcsRUFBRTtZQUNILHNDQUFzQztZQUN0QyxPQUFPLENBQUMsSUFBSSxDQUFDLDZEQUE2RCxDQUFDLENBQUM7WUFDNUUsY0FBYyxFQUFFLENBQUM7UUFDbkIsQ0FBQyxDQUNGLENBQUM7UUFDRixzQ0FBc0M7UUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyxpRkFBaUYsQ0FBQyxDQUFDO0tBQ2pHO0lBQUMsT0FBTyxHQUFHLEVBQUU7UUFDWixzQ0FBc0M7UUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyxxREFBcUQsRUFBRSxHQUFHLENBQUMsQ0FBQztLQUMxRTtBQUNILENBQUM7QUFqQkQsa0RBaUJDO0FBRUQsU0FBZ0IscUJBQXFCO0lBQ25DLElBQUksV0FBVyxJQUFJLFdBQVcsQ0FBQyxPQUFPLEVBQUU7UUFDdEMsSUFBSTtZQUFFLFdBQVcsQ0FBQyxPQUFPLEVBQUUsQ0FBQztTQUFFO1FBQUMsT0FBTyxFQUFFLEVBQUUsRUFBRSxVQUFVLEVBQUU7S0FDekQ7SUFDRCxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3JCLENBQUM7QUFMRCxzREFLQyJ9