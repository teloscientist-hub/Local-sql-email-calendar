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
//        - A/B/C/E/F/H/M/P/S/W/X: move to that letter's folder, log 'override'
//          if mismatch or 'accept' if match
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
const LETTER_TO_FOLDER = {
    a: 'Routed/AI',
    b: 'Routed/deals',
    c: 'Routed/coach sales',
    e: 'Routed/entertaining',
    f: 'Routed/Finance',
    h: 'Routed/aol7',
    m: 'Routed/models',
    p: 'Routed/pol',
    s: 'Routed/smm',
    w: 'Routed/Wellness',
    x: 'Routed/Tech Noise',
};
let _container = null;
let _state = 'idle'; // 'idle' | 'awaiting' | 'classifying-on-demand'
let _suggestion = null;
let _thread = null;
let _rfcId = null;
let _docKeyHandler = null;
let _subject = '';
// -------------------------------------------------------------------------
function _ensureContainer() {
    if (_container)
        return _container;
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
    if (!_container)
        return;
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
    if (backdrop)
        backdrop.addEventListener('click', function (e) {
            if (e.target === backdrop)
                _dismiss();
        });
}
function _renderClassifyingOnDemand(subject) {
    const bodyHTML = '<div style="font-size:14px;color:#444;">Classifying now (background skipped this one)…</div>';
    const hintHTML = 'Esc to cancel';
    _renderShell(subject, bodyHTML, hintHTML);
}
function _renderSuggestion(subject) {
    if (!_container || !_suggestion)
        return;
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
        hintHTML = '<b>N</b> = classify now · <b>A B C E F H M P S W X</b> = manual route · <b>Esc</b> = cancel';
    }
    else if (errorMsg) {
        bodyHTML =
            '<div style="font-size:13px;color:#c83838;">Error: ' + _escape(errorMsg) + '</div>';
        hintHTML = '<b>A B C E F H M P S W X</b> = manual route · <b>Esc</b> = cancel';
    }
    else if (!sf || sf === 'none') {
        bodyHTML =
            '<div style="font-size:14px;color:#666;font-style:italic;">No folder fits (LLM declined).</div>' +
                '<div style="margin-top:6px;font-size:12px;color:#888;line-height:1.4;">' + _escape(reason) + '</div>';
        hintHTML = '<b>A B C E F H M P S W X</b> = manual route · <b>Esc</b> = cancel';
    }
    else {
        const shortFolder = sf.replace(/^Routed\//, '');
        bodyHTML =
            '<div style="font-size:18px;font-weight:600;color:#222;">' +
                '→ ' + _escape(shortFolder) +
                '<span style="font-size:13px;color:#888;font-weight:400;margin-left:10px;">' +
                _escape(conf) +
                '</span>' +
                '</div>' +
                '<div style="margin-top:8px;font-size:12px;color:#666;line-height:1.4;">' + _escape(reason) + '</div>';
        hintHTML = '<b>Y</b>/Enter = confirm · <b>A B C E F H M P S W X</b> = override · <b>Esc</b> = cancel';
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
    if (!_thread || !_rfcId)
        return;
    _state = 'classifying-on-demand';
    _renderClassifyingOnDemand(_subject);
    let suggestion = null;
    try {
        // cached_only:false forces a real LLM call (60s timeout).
        suggestion = await sidecarClient.routeSuggest({
            rfc_message_id: _rfcId,
            cached_only: false,
        });
    }
    catch (err) {
        suggestion = null;
    }
    if (_state !== 'classifying-on-demand')
        return; // dismissed
    if (!suggestion || suggestion.error) {
        _suggestion = {
            suggested_folder: 'none',
            confidence: null,
            reason: (suggestion && suggestion.error) || 'sidecar unreachable',
            error: (suggestion && suggestion.error) || 'sidecar unreachable',
        };
    }
    else {
        _suggestion = suggestion;
    }
    _state = 'awaiting';
    _renderSuggestion(_subject);
}
function _onDocKeydown(e) {
    if (_state === 'idle')
        return;
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
        }
        else {
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
    if (!thread || !rfcId)
        return;
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
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] route overlay: cached lookup threw:', err);
        suggestion = null;
    }
    if (_state !== 'awaiting')
        return; // user dismissed mid-fetch
    if (!suggestion) {
        _suggestion = {
            suggested_folder: 'none',
            confidence: null,
            reason: 'sidecar unreachable',
            error: 'sidecar unreachable',
        };
    }
    else if (suggestion.error) {
        // Server populates error='not yet classified' for cache miss.
        _suggestion = {
            suggested_folder: suggestion.suggested_folder || null,
            confidence: suggestion.confidence,
            reason: suggestion.reason,
            error: suggestion.error,
        };
    }
    else {
        _suggestion = suggestion;
    }
    _renderSuggestion(_subject);
}
module.exports = { openRouteConfirmOverlay };
module.exports.openRouteConfirmOverlay = openRouteConfirmOverlay;
module.exports.default = { openRouteConfirmOverlay: openRouteConfirmOverlay };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGUtY29uZmlybS1vdmVybGF5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3JvdXRlLWNvbmZpcm0tb3ZlcmxheS5qc3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsNEJBQTRCO0FBQzVCLEVBQUU7QUFDRiw0RUFBNEU7QUFDNUUsRUFBRTtBQUNGLFFBQVE7QUFDUixzREFBc0Q7QUFDdEQsdUVBQXVFO0FBQ3ZFLG1EQUFtRDtBQUNuRCx3REFBd0Q7QUFDeEQsc0RBQXNEO0FBQ3RELDJFQUEyRTtBQUMzRSx3QkFBd0I7QUFDeEIsOERBQThEO0FBQzlELCtFQUErRTtBQUMvRSw0Q0FBNEM7QUFDNUMsb0NBQW9DO0FBQ3BDLEVBQUU7QUFDRixpRkFBaUY7QUFDakYsNkVBQTZFO0FBQzdFLDBFQUEwRTtBQUMxRSwrRUFBK0U7QUFDL0UsK0NBQStDO0FBRS9DLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQ2xELE1BQU0sRUFBRSxjQUFjLEVBQUUsR0FBRyxPQUFPLENBQUMsdUJBQXVCLENBQUMsQ0FBQztBQUU1RCxNQUFNLGNBQWMsR0FBRyx3QkFBd0IsQ0FBQztBQUVoRCxNQUFNLGdCQUFnQixHQUFHO0lBQ3ZCLENBQUMsRUFBRSxXQUFXO0lBQ2QsQ0FBQyxFQUFFLGNBQWM7SUFDakIsQ0FBQyxFQUFFLG9CQUFvQjtJQUN2QixDQUFDLEVBQUUscUJBQXFCO0lBQ3hCLENBQUMsRUFBRSxnQkFBZ0I7SUFDbkIsQ0FBQyxFQUFFLGFBQWE7SUFDaEIsQ0FBQyxFQUFFLGVBQWU7SUFDbEIsQ0FBQyxFQUFFLFlBQVk7SUFDZixDQUFDLEVBQUUsWUFBWTtJQUNmLENBQUMsRUFBRSxxQkFBcUI7SUFDeEIsQ0FBQyxFQUFFLG1CQUFtQjtDQUN2QixDQUFDO0FBRUYsSUFBSSxVQUFVLEdBQUcsSUFBSSxDQUFDO0FBQ3RCLElBQUksTUFBTSxHQUFHLE1BQU0sQ0FBQyxDQUFHLGdEQUFnRDtBQUN2RSxJQUFJ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