// route-confirm-overlay.jsx
//
// Phase 5.5.4 — "show then confirm" overlay for the LLM routing suggestion.
//
// Flow:
//   1. User presses Cmd+Option+Y on a focused thread.
//   2. Overlay opens with "Classifying…" while we call /route-suggest.
//   3. When the suggestion arrives, overlay shows:
//        - subject snippet (which thread we're routing)
//        - suggested folder + confidence + LLM reason
//        - key hints: Y/Enter = confirm · letter = override · Esc = cancel
//   4. User's next key:
//        - Y or Enter: move to suggested folder, log 'accept'
//        - A/C/D/E/F/M/P/S: move to that letter's folder, log 'override' if
//          mismatch or 'accept' if match
//        - Esc: dismiss, do nothing
//
// Implementation note: vanilla DOM (no React import), same as note-input-overlay
// — Mailspring's plugin sandbox doesn't expose react-dom and pulling our own
// would duplicate React instances. The keydown handler is attached at the
// document level in the capture phase so the existing routed-keystroke-handler
// doesn't ALSO fire while the overlay is open.

const sidecarClient = require('./sidecar-client');
const { moveSelectedTo } = require('./disposition-actions');

const PLUGIN_VERSION = 'mml-productivity@0.2.0';

// Letter → folder map for the route-confirm overlay. Keep in sync with
// keymaps/mml-routed.json, routed-keystroke-handler.js ROUTES, and the
// sidecar's config.py ROUTING_FOLDERS. Note: `d` is skipped because
// mod+alt+d collides with macOS Show/Hide Dock.
const LETTER_TO_FOLDER = {
  a: 'Routed/A',
  b: 'Routed/B',
  c: 'Routed/C',
  e: 'Routed/E',
  f: 'Routed/F',
  m: 'Routed/M',
  p: 'Routed/P',
  s: 'Routed/S',
};

let _container = null;
let _state = 'idle';   // 'idle' | 'awaiting' | 'classifying-on-demand'
let _suggestion = null;
let _thread = null;
let _rfcId = null;
let _docKeyHandler = null;
let _subject = '';

// -------------------------------------------------------------------------

function _ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.id = 'mml-route-confirm-portal';
  _container.setAttribute('data-mml-overlay', 'route-confirm');
  _container.style.cssText =
    'display:none; position:fixed; inset:0; z-index:99999; ' +
    'pointer-events:auto; font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
  document.body.appendChild(_container);
  return _container;
}

function _dismiss() {
  if (_container) {
    _container.style.display = 'none';
    _container.innerHTML = '';
  }
  if (_docKeyHandler) {
    document.removeEventListener('keydown', _docKeyHandler, true);
    _docKeyHandler = null;
  }
  _state = 'idle';
  _suggestion = null;
  _thread = null;
  _rfcId = null;
  _subject = '';
}

function _escape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _renderShell(subject, bodyHTML, hintHTML) {
  if (!_container) return;
  _container.innerHTML =
    '<div class="mml-route-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.22);">' +
      '<div class="mml-route-overlay" role="dialog" aria-label="Routing suggestion" ' +
            'style="position:absolute;top:22%;left:50%;transform:translateX(-50%);' +
                  'background:#fff;padding:14px 18px;border-radius:6px;' +
                  'box-shadow:0 8px 32px rgba(0,0,0,0.3);width:480px;max-width:92vw;">' +
        '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:#888;margin-bottom:4px;">Routing</div>' +
        '<div class="mml-route-subject" style="font-size:13px;color:#222;margin-bottom:12px;' +
              'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _escape(subject) + '</div>' +
        '<div class="mml-route-body" style="padding:6px 0;">' + bodyHTML + '</div>' +
        '<div class="mml-route-hint" style="margin-top:12px;font-size:11px;color:#666;line-height:1.5;">' + hintHTML + '</div>' +
      '</div>' +
    '</div>';
  const backdrop = _container.querySelector('.mml-route-backdrop');
  if (backdrop) backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) _dismiss();
  });
}

function _renderClassifyingOnDemand(subject) {
  const bodyHTML =
    '<div style="font-size:14px;color:#444;">Classifying now (background skipped this one)…</div>';
  const hintHTML = 'Esc to cancel';
  _renderShell(subject, bodyHTML, hintHTML);
}

function _renderSuggestion(subject) {
  if (!_container || !_suggestion) return;
  const sf = _suggestion.suggested_folder;
  const conf = (typeof _suggestion.confidence === 'number')
    ? Math.round(_suggestion.confidence * 100) + '%'
    : '—';
  const reason = _suggestion.reason || '';
  const errorMsg = _suggestion.error || null;
  const notYet = errorMsg === 'not yet classified';

  let bodyHTML;
  let hintHTML;
  if (notYet) {
    bodyHTML =
      '<div style="font-size:14px;color:#a76800;">⏳ Not yet classified.</div>' +
      '<div style="margin-top:6px;font-size:12px;color:#888;line-height:1.4;">' +
        'The background classifier hasn\'t reached this message. ' +
        'Press <b>N</b> to classify now (waits ~10–30s) or a letter to route manually.' +
      '</div>';
    hintHTML = '<b>N</b> = classify now · <b>A B C E F M P S</b> = manual route · <b>Esc</b> = cancel';
  } else if (errorMsg) {
    bodyHTML =
      '<div style="font-size:13px;color:#c83838;">Error: ' + _escape(errorMsg) + '</div>';
    hintHTML = '<b>A B C E F M P S</b> = manual route · <b>Esc</b> = cancel';
  } else if (!sf || sf === 'none') {
    bodyHTML =
      '<div style="font-size:14px;color:#666;font-style:italic;">No folder fits (LLM declined).</div>' +
      '<div style="margin-top:6px;font-size:12px;color:#888;line-height:1.4;">' + _escape(reason) + '</div>';
    hintHTML = '<b>A B C E F M P S</b> = manual route · <b>Esc</b> = cancel';
  } else {
    const shortFolder = sf.replace(/^Routed\//, '');
    bodyHTML =
      '<div style="font-size:18px;font-weight:600;color:#222;">' +
        '→ ' + _escape(shortFolder) +
        '<span style="font-size:13px;color:#888;font-weight:400;margin-left:10px;">' +
          _escape(conf) +
        '</span>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:12px;color:#666;line-height:1.4;">' + _escape(reason) + '</div>';
    hintHTML = '<b>Y</b>/Enter = confirm · <b>A B C E F M P S</b> = override · <b>Esc</b> = cancel';
  }

  _renderShell(subject, bodyHTML, hintHTML);
}

// -------------------------------------------------------------------------

function _moveAndLog(folder, source) {
  if (!_thread || !folder) {
    _dismiss();
    return;
  }
  const moveResult = moveSelectedTo(folder, [_thread]);
  if (!moveResult || moveResult.queued === 0) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] route: no "' + folder + '" on this account');
    _dismiss();
    return;
  }
  if (_rfcId) {
    sidecarClient.routeCorrection({
      rfc_message_id: _rfcId,
      suggested_folder: _suggestion ? _suggestion.suggested_folder : null,
      accepted_folder: folder,
      source: source,
      plugin_version: PLUGIN_VERSION,
    }).then(function (res) {
      if (res && res.error) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] /route-correction error:', res.error);
      }
    }).catch(function (err) {
      // eslint-disable-next-line no-console
      console.warn('[mml-productivity] /route-correction threw:', err);
    });
  }
  _dismiss();
}

async function _classifyNow() {
  if (!_thread || !_rfcId) return;
  _state = 'classifying-on-demand';
  _renderClassifyingOnDemand(_subject);
  let suggestion = null;
  try {
    // cached_only:false forces a real LLM call (60s timeout).
    suggestion = await sidecarClient.routeSuggest({
      rfc_message_id: _rfcId,
      cached_only: false,
    });
  } catch (err) {
    suggestion = null;
  }
  if (_state !== 'classifying-on-demand') return; // dismissed
  if (!suggestion || suggestion.error) {
    _suggestion = {
      suggested_folder: 'none',
      confidence: null,
      reason: (suggestion && suggestion.error) || 'sidecar unreachable',
      error: (suggestion && suggestion.error) || 'sidecar unreachable',
    };
  } else {
    _suggestion = suggestion;
  }
  _state = 'awaiting';
  _renderSuggestion(_subject);
}

function _onDocKeydown(e) {
  if (_state === 'idle') return;
  const key = (e.key || '').toLowerCase();

  if (key === 'escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    _dismiss();
    return;
  }

  if (_state === 'classifying-on-demand') {
    // Only Esc works while waiting on the LLM. Block other keys.
    if (key === 'y' || key === 'enter' || key === 'n' || key in LETTER_TO_FOLDER) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }

  // _state === 'awaiting'
  const sf = _suggestion && _suggestion.suggested_folder;
  const notYet = _suggestion && _suggestion.error === 'not yet classified';

  if (notYet && key === 'n') {
    e.preventDefault();
    e.stopImmediatePropagation();
    _classifyNow();
    return;
  }

  if (key === 'y' || key === 'enter') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (sf && sf !== 'none') {
      _moveAndLog(sf, 'accept');
    } else {
      // Nothing valid to confirm — Y just dismisses.
      _dismiss();
    }
    return;
  }

  if (key in LETTER_TO_FOLDER) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const folder = LETTER_TO_FOLDER[key];
    const source = (sf && sf === folder && sf !== 'none') ? 'accept' : 'override';
    _moveAndLog(folder, source);
    return;
  }
}

// -------------------------------------------------------------------------

/**
 * Open the route-confirm overlay for a focused thread. Begins classification
 * immediately; user then confirms/overrides/cancels.
 *
 *   thread:  Mailspring Thread instance (focused)
 *   rfcId:   RFC-822 Message-ID of the latest message in the thread
 *
 * Idempotent — calling twice closes the prior instance.
 */
async function openRouteConfirmOverlay(thread, rfcId) {
  if (!thread || !rfcId) return;

  _dismiss(); // wipe any prior instance
  _thread = thread;
  _rfcId = rfcId;
  _subject = (thread.subject || '(no subject)');

  // Listen for keys BEFORE the network call so the user can Esc out even
  // during the (very fast) cached lookup.
  _docKeyHandler = _onDocKeydown;
  document.addEventListener('keydown', _docKeyHandler, true);

  const container = _ensureContainer();
  container.style.display = '';

  // Cached-only fetch — instant if the message has been classified by the
  // background worker or backfill. If not, the server returns
  // error='not yet classified' and the overlay shows the "press N to
  // classify now" affordance.
  _state = 'awaiting';
  let suggestion = null;
  try {
    suggestion = await sidecarClient.routeSuggest({
      rfc_message_id: rfcId,
      cached_only: true,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] route overlay: cached lookup threw:', err);
    suggestion = null;
  }

  if (_state !== 'awaiting') return; // user dismissed mid-fetch

  if (!suggestion) {
    _suggestion = {
      suggested_folder: 'none',
      confidence: null,
      reason: 'sidecar unreachable',
      error: 'sidecar unreachable',
    };
  } else if (suggestion.error) {
    // Server populates error='not yet classified' for cache miss.
    _suggestion = {
      suggested_folder: suggestion.suggested_folder || null,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      error: suggestion.error,
    };
  } else {
    _suggestion = suggestion;
  }

  _renderSuggestion(_subject);
}

module.exports = { openRouteConfirmOverlay };
module.exports.openRouteConfirmOverlay = openRouteConfirmOverlay;
module.exports.default = { openRouteConfirmOverlay: openRouteConfirmOverlay };
