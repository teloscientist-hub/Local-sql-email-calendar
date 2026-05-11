// note-keystroke-handler.js
//
// Phase 3 — Ctrl+Cmd+N → open the note-input overlay for the focused
// thread's latest message. The overlay handles Esc / Enter and POSTs
// to /add-note. The overlay errors-inline if no rating row exists yet
// for the focused message (plugin v0.1 doesn't auto-create one — the
// owner can hit Ctrl+Cmd+0..9 first).

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

export function registerNoteCommand() {
  try {
    _disposable = AppEnv.commands.add(
      document.body,
      'mml-productivity:add-note',
      () => {
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] command fired: mml-productivity:add-note');
        openForFocused();
      },
    );
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] registered note command. Try Ctrl+Cmd+N on a focused thread.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] failed to register note command:', err);
  }
}

export function unregisterNoteCommand() {
  if (_disposable && _disposable.dispose) {
    try { _disposable.dispose(); } catch (_e) { /* noop */ }
  }
  _disposable = null;
}
