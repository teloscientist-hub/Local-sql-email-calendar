// routed-keystroke-handler.js
//
// Phase 5.5.1 — Cmd+Option+<letter> → move selected thread(s) into one of
// the `Routed/<name>` folders. Same move recipe as the existing
// disposition handler (Cmd+Shift+1..4): ChangeFolderTask for IMAP,
// ChangeLabelsTask for Gmail. Folder lookup by displayName, pre-created
// in Phase 5.
//
// =====================================================================
// Folder names below are GENERIC PLACEHOLDERS. Rename `Routed/A`..`H` to
// your own folder names (e.g. `Routed/clients`, `Routed/newsletters`)
// and keep four files in sync:
//   - this ROUTES dict
//   - keymaps/mml-routed.json (key bindings)
//   - services/mml-classifier/mml_classifier/config.py ROUTING_FOLDERS
//   - the routing prompt(s) in services/.../prompts/route_suggest_v*.md
// The unified-sidebar logic in sidebar-extension.js discovers folders by
// their `Routed/` prefix at runtime, so it's name-agnostic.
//
// Phase 5.5.2 — each press also logs a routing_corrections row to the
// sidecar so corrections become training signal. Source semantics:
//   * 'accept'   — a cached LLM suggestion (from a prior Cmd+Option+Y on
//                  the same thread, this session) matched the chosen letter.
//   * 'override' — a cached LLM suggestion existed but pointed to a
//                  different folder than the letter chosen.
//   * 'manual'   — no cached suggestion (the common case until a chip is
//                  added to the badge).

import { moveSelectedTo } from './disposition-actions';
import { FocusedContentStore } from 'mailspring-exports';

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
  return FocusedContentStore && FocusedContentStore.focused
    ? FocusedContentStore.focused('thread')
    : null;
}

async function _lastRfcId(thread) {
  const ids = await sidecarClient.rfcIdsForThread(thread);
  if (!ids || ids.length === 0) return null;
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
  const result = moveSelectedTo(folderName, thread ? [thread] : []);
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
        console.warn(
          `[mml-productivity] /route-correction (${source}) error:`, res.error
        );
      }
    });
  }
}

export function registerRoutedCommands() {
  for (const [suffix, folderName] of Object.entries(ROUTES)) {
    const commandName = `mml-productivity:route-to-${suffix}`;
    try {
      const d = AppEnv.commands.add(document.body, commandName, () => {
        // eslint-disable-next-line no-console
        console.info(`[mml-productivity] route command fired: ${commandName} → ${folderName}`);
        routeToFolder(folderName);
      });
      _commandDisposables.push(d);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mml-productivity] failed to register ${commandName}:`, err);
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[mml-productivity] registered ${_commandDisposables.length} routed commands. ` +
    'Try Cmd+Option+A/B/C/E/F/M/P/S on a focused thread.'
  );
}

export function unregisterRoutedCommands() {
  for (const d of _commandDisposables) {
    try { if (d && d.dispose) d.dispose(); } catch (_e) { /* noop */ }
  }
  _commandDisposables = [];
}
