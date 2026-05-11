// event-keystroke-handler.js
//
// Phase 5 — Ctrl+Cmd+E → open the event-input overlay for the focused
// thread's latest message. The overlay handles its own LLM draft fetch
// via /draft-event in the background and the submit via /create-event.
//
// Grain: focused thread's most recent message (same rule as Ctrl+Cmd+N).

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

export function registerEventCommand() {
  try {
    _disposable = AppEnv.commands.add(
      document.body,
      'mml-productivity:create-event',
      () => {
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] command fired: mml-productivity:create-event');
        openForFocused();
      },
    );
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] registered create-event command. Try Ctrl+Cmd+E on a focused thread.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] failed to register create-event command:', err);
  }
}

export function unregisterEventCommand() {
  if (_disposable && _disposable.dispose) {
    try { _disposable.dispose(); } catch (_e) { /* noop */ }
  }
  _disposable = null;
}
