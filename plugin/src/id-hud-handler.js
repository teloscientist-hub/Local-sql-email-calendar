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
  } catch (err) {
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] id-hud: messageLookup failed', err);
  }
  const rows = (lookup && Array.isArray(lookup.messages)) ? lookup.messages : [];
  openIdHudOverlay(ids, rows);
}

function _onContextMenu(e) {
  const threadId = _findRowThreadId(e.target);
  if (!threadId) return;
  e.preventDefault();
  e.stopPropagation();
  _openHudForThreadId(threadId);
}

export function registerIdHud() {
  if (_listener) return;
  _listener = _onContextMenu;
  // Capture so we win against Mailspring's own contextmenu wiring.
  document.addEventListener('contextmenu', _listener, true);
  // eslint-disable-next-line no-console
  console.info('[mml-productivity] id-hud: right-click handler registered.');
}

export function unregisterIdHud() {
  if (!_listener) return;
  document.removeEventListener('contextmenu', _listener, true);
  _listener = null;
}
