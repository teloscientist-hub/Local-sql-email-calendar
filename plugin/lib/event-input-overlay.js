// event-input-overlay.jsx
//
// Phase 5 — vanilla-DOM overlay summoned by Ctrl+Cmd+E. Opens
// immediately with a "Drafting event…" placeholder, fires
// /draft-event in the background, populates fields when the draft
// returns, then POSTs /create-event on submit. On success, shows the
// GCal htmlLink briefly and dismisses.
//
// Same vanilla-DOM rationale as note-input-overlay.jsx — the
// Mailspring sandbox doesn't expose react-dom and importing our own
// React creates duplicate-instance hazards.
//
// Public API:
//   openEventOverlay(rfcMessageId, onClose?) → close fn
const sidecarClient = require('./sidecar-client');
const PLUGIN_VERSION = 'mml-productivity@0.2.0';
let _container = null;
let _activeOnClose = null;
function _ensureContainer() {
    if (_container)
        return _container;
    _container = document.createElement('div');
    _container.id = 'mml-event-input-portal';
    _container.setAttribute('data-mml-overlay', 'event-input');
    _container.style.cssText =
        'display:none; position:fixed; inset:0; z-index:99999;';
    document.body.appendChild(_container);
    return _container;
}
function _dismiss() {
    if (_container) {
        _container.style.display = 'none';
        _container.innerHTML = '';
    }
    const cb = _activeOnClose;
    _activeOnClose = null;
    if (typeof cb === 'function') {
        try {
            cb();
        }
        catch (_e) { /* noop */ }
    }
}
function _showError(message) {
    if (!_container)
        return;
    const errEl = _container.querySelector('.mml-event-overlay-error');
    const hintEl = _container.querySelector('.mml-event-overlay-hint');
    if (errEl) {
        errEl.textContent = message;
        errEl.style.display = '';
    }
    if (hintEl)
        hintEl.style.display = 'none';
}
function _clearError() {
    if (!_container)
        return;
    const errEl = _container.querySelector('.mml-event-overlay-error');
    const hintEl = _container.querySelector('.mml-event-overlay-hint');
    if (errEl)
        errEl.style.display = 'none';
    if (hintEl)
        hintEl.style.display = '';
}
function _setStatus(message) {
    if (!_container)
        return;
    const el = _container.querySelector('.mml-event-overlay-status');
    if (el) {
        el.textContent = message || '';
        el.style.display = message ? '' : 'none';
    }
}
function _escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// ISO 8601 → value for <input type="datetime-local"> (YYYY-MM-DDTHH:MM).
// datetime-local has no timezone field; we keep the offset from the source
// string and re-attach it on submit via _datetimeLocalToIso().
function _isoToDatetimeLocal(iso) {
    if (!iso)
        return '';
    // Strip the tz offset and seconds — datetime-local expects "YYYY-MM-DDTHH:MM".
    const m = String(iso).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    return m ? m[1] : '';
}
function _isoTzOffset(iso) {
    if (!iso)
        return '';
    const m = String(iso).match(/(Z|[+\-]\d{2}:?\d{2})$/);
    return m ? m[1] : '';
}
function _datetimeLocalToIso(localValue, tzOffset) {
    if (!localValue)
        return '';
    // Append :00 for seconds if missing, then the tz offset.
    const withSeconds = /T\d{2}:\d{2}$/.test(localValue) ? `${localValue}:00` : localValue;
    return tzOffset ? `${withSeconds}${tzOffset}` : withSeconds;
}
function _renderInto(container, rfcMessageId) {
    container.innerHTML =
        '<div class="mml-event-overlay-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.25);">' +
            '<div class="mml-event-overlay" role="dialog" aria-label="Create calendar event" style="position:absolute;top:12%;left:50%;transform:translateX(-50%);background:#fff;padding:16px 20px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,0.22);width:440px;max-height:78vh;overflow:auto;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;">' +
            '<div class="mml-event-overlay-header" style="font-weight:600;font-size:14px;margin-bottom:10px;">Create calendar event</div>' +
            '<div class="mml-event-overlay-status" style="color:#888;font-size:12px;margin-bottom:8px;">Drafting from email…</div>' +
            '<label style="display:block;font-size:11px;color:#666;margin-top:8px;">Title</label>' +
            '<input type="text" class="mml-event-overlay-title" disabled style="width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:13px;"/>' +
            '<div style="display:flex;gap:8px;margin-top:8px;">' +
            '<div style="flex:1;">' +
            '<label style="display:block;font-size:11px;color:#666;">Start</label>' +
            '<input type="datetime-local" class="mml-event-overlay-start" disabled style="width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:13px;"/>' +
            '</div>' +
            '<div style="width:110px;">' +
            '<label style="display:block;font-size:11px;color:#666;">Duration</label>' +
            '<select class="mml-event-overlay-duration" disabled style="width:100%;padding:6px 4px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:13px;">' +
            '<option value="15">15 min</option>' +
            '<option value="30" selected>30 min</option>' +
            '<option value="45">45 min</option>' +
            '<option value="60">60 min</option>' +
            '<option value="90">90 min</option>' +
            '</select>' +
            '</div>' +
            '</div>' +
            '<label style="display:block;font-size:11px;color:#666;margin-top:10px;">Description</label>' +
            '<textarea class="mml-event-overlay-description" rows="3" disabled style="width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:13px;resize:vertical;font-family:inherit;"></textarea>' +
            '<div class="mml-event-overlay-attendees-block" style="margin-top:10px;">' +
            '<label style="display:block;font-size:11px;color:#666;">Attendees (uncheck to skip)</label>' +
            '<div class="mml-event-overlay-attendees" style="border:1px solid #eee;border-radius:4px;padding:4px 8px;max-height:120px;overflow:auto;font-size:12px;color:#888;">no attendees suggested</div>' +
            '</div>' +
            '<div class="mml-event-overlay-confidence" style="margin-top:6px;font-size:11px;color:#999;"></div>' +
            '<div class="mml-event-overlay-footer" style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;">' +
            '<span class="mml-event-overlay-hint" style="font-size:11px;color:#666;">⌘+Enter to create · Esc to cancel</span>' +
            '<span class="mml-event-overlay-error" style="display:none;color:#c00;font-size:12px;flex:1;text-align:right;margin-right:8px;"></span>' +
            '<button class="mml-event-overlay-submit" disabled style="padding:6px 14px;background:#1a73e8;color:#fff;border:none;border-radius:4px;font-size:13px;cursor:pointer;">Create</button>' +
            '</div>' +
            '</div>' +
            '</div>';
    const backdrop = container.querySelector('.mml-event-overlay-backdrop');
    const titleEl = container.querySelector('.mml-event-overlay-title');
    const startEl = container.querySelector('.mml-event-overlay-start');
    const durationEl = container.querySelector('.mml-event-overlay-duration');
    const descEl = container.querySelector('.mml-event-overlay-description');
    const submitEl = container.querySelector('.mml-event-overlay-submit');
    const state = {
        rfcMessageId,
        tzOffset: '',
        attendees: [],
        drafted: false,
        submitting: false,
    };
    function _enableForm(enabled) {
        titleEl.disabled = !enabled;
        startEl.disabled = !enabled;
        durationEl.disabled = !enabled;
        descEl.disabled = !enabled;
        submitEl.disabled = !enabled;
    }
    function _renderAttendees() {
        const wrap = container.querySelector('.mml-event-overlay-attendees');
        if (!wrap)
            return;
        if (state.attendees.length === 0) {
            wrap.textContent = 'no attendees suggested';
            wrap.style.color = '#888';
            return;
        }
        wrap.style.color = '#222';
        wrap.innerHTML = state.attendees.map((a, i) => '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;">' +
            `<input type="checkbox" class="mml-event-overlay-attendee" data-i="${i}" ${a.checked ? 'checked' : ''}/>` +
            `<span>${_escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)}</span>` +
            '</label>').join('');
        wrap.querySelectorAll('input.mml-event-overlay-attendee').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const idx = parseInt(e.target.getAttribute('data-i'), 10);
                if (!Number.isNaN(idx) && state.attendees[idx]) {
                    state.attendees[idx].checked = !!e.target.checked;
                }
            });
        });
    }
    function _applyDraft(draft) {
        state.drafted = true;
        _enableForm(true);
        if (draft) {
            if (draft.title)
                titleEl.value = String(draft.title);
            if (draft.proposed_start_iso) {
                startEl.value = _isoToDatetimeLocal(draft.proposed_start_iso);
                state.tzOffset = _isoTzOffset(draft.proposed_start_iso);
            }
            if (typeof draft.duration_minutes === 'number') {
                const opt = String(draft.duration_minutes);
                if (Array.from(durationEl.options).some(o => o.value === opt)) {
                    durationEl.value = opt;
                }
            }
            if (draft.description)
                descEl.value = String(draft.description);
            if (Array.isArray(draft.attendees) && draft.attendees.length > 0) {
                state.attendees = draft.attendees.map(a => ({
                    email: String(a.email || '').trim().toLowerCase(),
                    name: a.name ? String(a.name) : '',
                    checked: true,
                })).filter(a => a.email);
                _renderAttendees();
            }
            const confEl = container.querySelector('.mml-event-overlay-confidence');
            if (draft.confidence === 'low') {
                confEl.textContent = '(low-confidence draft — review carefully)';
            }
            else if (draft.confidence === 'high') {
                confEl.textContent = '(high-confidence draft)';
            }
        }
        _setStatus('');
        titleEl.focus();
    }
    async function _doDraft() {
        let result = null;
        try {
            result = await sidecarClient.draftEvent({ rfc_message_id: rfcMessageId });
        }
        catch (_e) {
            result = null;
        }
        if (!result) {
            // Sidecar unreachable or down — let the user fill in by hand.
            _setStatus('');
            _enableForm(true);
            _showError('draft unavailable — fill in manually');
            titleEl.focus();
            return;
        }
        if (result.error) {
            // Even on error, the drafter returns sensible fallbacks.
            _applyDraft(result);
            _showError(result.error);
            return;
        }
        _applyDraft(result);
    }
    async function _doSubmit() {
        if (state.submitting)
            return;
        if (!state.drafted)
            return; // hasn't loaded yet
        _clearError();
        const title = (titleEl.value || '').trim();
        if (!title) {
            _showError('title is required');
            titleEl.focus();
            return;
        }
        const startLocal = startEl.value;
        if (!startLocal) {
            _showError('start time is required');
            startEl.focus();
            return;
        }
        const duration = parseInt(durationEl.value, 10);
        const startIso = _datetimeLocalToIso(startLocal, state.tzOffset);
        const attendees = state.attendees
            .filter(a => a.checked)
            .map(a => a.name ? { email: a.email, name: a.name } : { email: a.email });
        state.submitting = true;
        _enableForm(false);
        _setStatus('Creating event…');
        let result = null;
        try {
            result = await sidecarClient.createEvent({
                rfc_message_id: rfcMessageId,
                title,
                description: (descEl.value || '').trim(),
                start_iso: startIso,
                duration_minutes: duration,
                attendees,
                plugin_version: PLUGIN_VERSION,
                llm_drafted: true,
            });
        }
        catch (_e) {
            result = null;
        }
        state.submitting = false;
        _setStatus('');
        if (!result) {
            _enableForm(true);
            _showError('sidecar unreachable — try again');
            return;
        }
        if (result.error) {
            _enableForm(true);
            _showError(result.error);
            return;
        }
        // Success — show a brief link then dismiss.
        if (result.html_link) {
            _setStatus(`Created → ${result.html_link}`);
        }
        else {
            _setStatus('Created.');
        }
        setTimeout(() => _dismiss(), 900);
    }
    backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop && !state.submitting)
            _dismiss();
    });
    function _keyHandler(e) {
        if (e.key === 'Escape') {
            if (state.submitting)
                return;
            e.stopPropagation();
            _dismiss();
            return;
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            _doSubmit();
        }
    }
    // Bind on the dialog so keystrokes inside any field reach us.
    container.addEventListener('keydown', _keyHandler);
    submitEl.addEventListener('click', function (e) {
        e.preventDefault();
        _doSubmit();
    });
    [titleEl, startEl, durationEl, descEl].forEach(el => {
        el.addEventListener('input', _clearError);
        el.addEventListener('change', _clearError);
    });
    // Kick the LLM draft right away.
    _doDraft();
}
/**
 * Open the event-input overlay for a given RFC-822 Message-ID. Returns a
 * close fn. Idempotent — calling twice closes the prior instance first.
 */
function openEventOverlay(rfcMessageId, onClose) {
    if (!rfcMessageId)
        return function () { };
    _dismiss();
    const container = _ensureContainer();
    _activeOnClose = (typeof onClose === 'function') ? onClose : null;
    container.style.display = '';
    _renderInto(container, rfcMessageId);
    return _dismiss;
}
module.exports = { openEventOverlay };
module.exports.openEventOverlay = openEventOverlay;
module.exports.default = { openEventOverlay: openEventOverlay };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnQtaW5wdXQtb3ZlcmxheS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9ldmVudC1pbnB1dC1vdmVybGF5LmpzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwQkFBMEI7QUFDMUIsRUFBRTtBQUNGLDhEQUE4RDtBQUM5RCwwREFBMEQ7QUFDMUQsa0VBQWtFO0FBQ2xFLHFFQUFxRTtBQUNyRSx1Q0FBdUM7QUFDdkMsRUFBRTtBQUNGLDZEQUE2RDtBQUM3RCxvRUFBb0U7QUFDcEUsNENBQTRDO0FBQzVDLEVBQUU7QUFDRixjQUFjO0FBQ2Qsd0RBQXdEO0FBRXhELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBRWxELE1BQU0sY0FBYyxHQUFHLHdCQUF3QixDQUFDO0FBRWhELElBQUksVUFBVSxHQUFHLElBQUksQ0FBQztBQUN0QixJQUFJLGNBQWMsR0FBRyxJQUFJLENBQUM7QUFFMUIsU0FBUyxnQkFBZ0I7SUFDdkIsSUFBSSxVQUFVO1FBQUUsT0FBTyxVQUFVLENBQUM7SUFDbEMsVUFBVSxHQUFHLFFBQVEsQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDM0MsVUFBVSxDQUFDLEVBQUUsR0FBRyx3QkFBd0IsQ0FBQztJQUN6QyxVQUFVLENBQUMsWUFBWSxDQUFDLGtCQUFrQixFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBQzNELFVBQVUsQ0FBQyxLQUFLLENBQUMsT0FBTztRQUN0Qix1REFBdUQsQ0FBQztJQUMxRCxRQUFRLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUN0QyxPQUFPLFVBQVUsQ0FBQztBQUNwQixDQUFDO0FBRUQsU0FBUyxRQUFRO0lBQ2YsSUFBSSxVQUFVLEVBQUU7UUFDZCxVQUFVLENBQUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxNQUFNLENBQUM7UUFDbEMsVUFBVSxDQUFDLFNBQVMsR0FBRyxFQUFFLENBQUM7S0FDM0I7SUFDRCxNQUFN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