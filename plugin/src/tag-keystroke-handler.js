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
  if (!thread) return null;
  const ids = await sidecarClient.rfcIdsForThread(thread);
  if (!ids || ids.length === 0) return null;
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
  if (!state) return { rating: null, cluster_id: null };
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

export function registerTagCommands() {
  for (const [name, rating] of Object.entries(COMMAND_TO_RATING)) {
    try {
      const d = AppEnv.commands.add(document.body, name, () => {
        // eslint-disable-next-line no-console
        console.info(`[mml-productivity] command fired: ${name} (rating=${rating})`);
        tagFocused(rating);
      });
      _commandDisposables.push(d);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mml-productivity] failed to register ${name}:`, err);
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[mml-productivity] registered ${_commandDisposables.length} tag commands. ` +
    'Try Ctrl+Cmd+0..9 on a focused thread.'
  );
}

export function unregisterTagCommands() {
  for (const d of _commandDisposables) {
    try { if (d && d.dispose) d.dispose(); } catch (_e) { /* noop */ }
  }
  _commandDisposables = [];
}
