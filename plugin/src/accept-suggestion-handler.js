// accept-suggestion-handler.js
//
// Phase 5.5.4 — Cmd+Option+Y opens the route-confirm overlay. The overlay
// (route-confirm-overlay.jsx) handles classification, display, and the
// confirm/override/cancel keystrokes. This module is now a thin trigger
// only — no direct moves, no direct correction logging.

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

export function registerAcceptCommand() {
  if (_disposable) return;
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[mml-productivity] failed to register ${COMMAND_NAME}:`, err);
  }
}

export function unregisterAcceptCommand() {
  if (_disposable && _disposable.dispose) {
    try { _disposable.dispose(); } catch (_e) { /* noop */ }
  }
  _disposable = null;
}
