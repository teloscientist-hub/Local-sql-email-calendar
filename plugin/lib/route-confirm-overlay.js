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
        hintHTML = '<b>N</b> = classify now · <b>A B C E F M P S</b> = manual route · <b>Esc</b> = cancel';
    }
    else if (errorMsg) {
        bodyHTML =
            '<div style="font-size:13px;color:#c83838;">Error: ' + _escape(errorMsg) + '</div>';
        hintHTML = '<b>A B C E F M P S</b> = manual route · <b>Esc</b> = cancel';
    }
    else if (!sf || sf === 'none') {
        bodyHTML =
            '<div style="font-size:14px;color:#666;font-style:italic;">No folder fits (LLM declined).</div>' +
                '<div style="margin-top:6px;font-size:12px;color:#888;line-height:1.4;">' + _escape(reason) + '</div>';
        hintHTML = '<b>A B C E F M P S</b> = manual route · <b>Esc</b> = cancel';
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGUtY29uZmlybS1vdmVybGF5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3JvdXRlLWNvbmZpcm0tb3ZlcmxheS5qc3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsNEJBQTRCO0FBQzVCLEVBQUU7QUFDRiw0RUFBNEU7QUFDNUUsRUFBRTtBQUNGLFFBQVE7QUFDUixzREFBc0Q7QUFDdEQsdUVBQXVFO0FBQ3ZFLG1EQUFtRDtBQUNuRCx3REFBd0Q7QUFDeEQsc0RBQXNEO0FBQ3RELDJFQUEyRTtBQUMzRSx3QkFBd0I7QUFDeEIsOERBQThEO0FBQzlELDRFQUE0RTtBQUM1RSx5Q0FBeUM7QUFDekMsb0NBQW9DO0FBQ3BDLEVBQUU7QUFDRixpRkFBaUY7QUFDakYsNkVBQTZFO0FBQzdFLDBFQUEwRTtBQUMxRSwrRUFBK0U7QUFDL0UsK0NBQStDO0FBRS9DLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQ2xELE1BQU0sRUFBRSxjQUFjLEVBQUUsR0FBRyxPQUFPLENBQUMsdUJBQXVCLENBQUMsQ0FBQztBQUU1RCxNQUFNLGNBQWMsR0FBRyx3QkFBd0IsQ0FBQztBQUVoRCxNQUFNLGdCQUFnQixHQUFHO0lBQ3ZCLENBQUMsRUFBRSxhQUFhO0lBQ2hCLENBQUMsRUFBRSxjQUFjO0lBQ2pCLENBQUMsRUFBRSxvQkFBb0I7SUFDdkIsQ0FBQyxFQUFFLGNBQWM7SUFDakIsQ0FBQyxFQUFFLFlBQVk7SUFDZixDQUFDLEVBQUUsZUFBZTtJQUNsQixDQUFDLEVBQUUsWUFBWTtJQUNmLENBQUMsRUFBRSxZQUFZO0NBQ2hCLENBQUM7QUFFRixJQUFJLFVBQVUsR0FBRyxJQUFJLENBQUM7QUFDdEIsSUFBSSxNQUFNLEdBQUcsTUFBTSxDQUFDLENBQUcsZ0RBQWdEO0FBQ3ZFLElBQUksV0FBVyxHQUFHLElBQUksQ0FBQztBQUN2QixJQUFJLE9BQU8sR0FBRyxJQUFJLENBQUM7QUFDbkIsSUFBSSxNQUFNLEdB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