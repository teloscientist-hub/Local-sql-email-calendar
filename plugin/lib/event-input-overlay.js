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
// Split an ISO 8601 timestamp into the pieces our inputs expect:
//   date  → "YYYY-MM-DD" for <input type="date">
//   time  → "HH:MM"      for the time <select>
//   tz    → "Z" or "+HH:MM" etc; re-attached on submit
function _isoToDate(iso) {
    if (!iso)
        return '';
    const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
}
function _isoToTime(iso) {
    if (!iso)
        return '';
    const m = String(iso).match(/T(\d{2}:\d{2})/);
    return m ? m[1] : '';
}
function _isoTzOffset(iso) {
    if (!iso)
        return '';
    const m = String(iso).match(/(Z|[+\-]\d{2}:?\d{2})$/);
    return m ? m[1] : '';
}
function _combineDateTime(date, time, tzOffset) {
    if (!date || !time)
        return '';
    return tzOffset ? `${date}T${time}:00${tzOffset}` : `${date}T${time}:00`;
}
// "13:30" → "1:30 PM" for the dropdown label.
function _formatTimeLabel(hhmm) {
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
// 96 options, 00:00 → 23:45 at 15-minute intervals.
function _buildTimeOptions() {
    const options = [];
    for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 15) {
            const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            options.push(`<option value="${value}">${_formatTimeLabel(value)}</option>`);
        }
    }
    return options.join('');
}
// Round "HH:MM" to the nearest 15-minute slot the dropdown contains. The
// sidecar may return 10:07 etc; the select can only display exact values.
function _snapTime(hhmm) {
    if (!hhmm)
        return '';
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    if (Number.isNaN(h) || Number.isNaN(m))
        return '';
    const snapped = Math.round(m / 15) * 15;
    if (snapped === 60) {
        return `${String((h + 1) % 24).padStart(2, '0')}:00`;
    }
    return `${String(h).padStart(2, '0')}:${String(snapped).padStart(2, '0')}`;
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
            '<div style="flex:1.1;">' +
            '<label style="display:block;font-size:11px;color:#666;">Date</label>' +
            '<input type="date" class="mml-event-overlay-date" disabled style="width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:13px;"/>' +
            '</div>' +
            '<div style="flex:1;">' +
            '<label style="display:block;font-size:11px;color:#666;">Time</label>' +
            '<select class="mml-event-overlay-time" disabled style="width:100%;padding:6px 4px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:13px;">' +
            _buildTimeOptions() +
            '</select>' +
            '</div>' +
            '<div style="width:90px;">' +
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
            '<div class="mml-event-overlay-description" contenteditable="false" style="width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-size:13px;font-family:inherit;min-height:64px;max-height:220px;overflow-y:auto;background:#fafafa;color:#222;line-height:1.45;outline:none;"></div>' +
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
    const dateEl = container.querySelector('.mml-event-overlay-date');
    const timeEl = container.querySelector('.mml-event-overlay-time');
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
        dateEl.disabled = !enabled;
        timeEl.disabled = !enabled;
        durationEl.disabled = !enabled;
        descEl.setAttribute('contenteditable', enabled ? 'true' : 'false');
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
                dateEl.value = _isoToDate(draft.proposed_start_iso);
                const snapped = _snapTime(_isoToTime(draft.proposed_start_iso));
                if (snapped && Array.from(timeEl.options).some(o => o.value === snapped)) {
                    timeEl.value = snapped;
                }
                state.tzOffset = _isoTzOffset(draft.proposed_start_iso);
            }
            if (typeof draft.duration_minutes === 'number') {
                const opt = String(draft.duration_minutes);
                if (Array.from(durationEl.options).some(o => o.value === opt)) {
                    durationEl.value = opt;
                }
            }
            if (draft.description)
                descEl.innerHTML = String(draft.description);
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
        const dateVal = dateEl.value;
        const timeVal = timeEl.value;
        if (!dateVal) {
            _showError('date is required');
            dateEl.focus();
            return;
        }
        if (!timeVal) {
            _showError('time is required');
            timeEl.focus();
            return;
        }
        const duration = parseInt(durationEl.value, 10);
        const startIso = _combineDateTime(dateVal, timeVal, state.tzOffset);
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
                description: (descEl.innerHTML || '').trim(),
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
    [titleEl, dateEl, timeEl, durationEl, descEl].forEach(el => {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnQtaW5wdXQtb3ZlcmxheS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9ldmVudC1pbnB1dC1vdmVybGF5LmpzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwQkFBMEI7QUFDMUIsRUFBRTtBQUNGLDhEQUE4RDtBQUM5RCwwREFBMEQ7QUFDMUQsa0VBQWtFO0FBQ2xFLHFFQUFxRTtBQUNyRSx1Q0FBdUM7QUFDdkMsRUFBRTtBQUNGLDZEQUE2RDtBQUM3RCxvRUFBb0U7QUFDcEUsNENBQTRDO0FBQzVDLEVBQUU7QUFDRixjQUFjO0FBQ2Qsd0RBQXdEO0FBRXhELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBRWxELE1BQU0sY0FBYyxHQUFHLHdCQUF3QixDQUFDO0FBRWhELElBQUksVUFBVSxHQUFHLElBQUksQ0FBQztBQUN0QixJQUFJLGNBQWMsR0FBRyxJQUFJLENBQUM7QUFFMUIsU0FBUyxnQkFBZ0I7SUFDdkIsSUFBSSxVQUFVO1FBQUUsT0FBTyxVQUFVLENBQUM7SUFDbEMsVUFBVSxHQUFHLFFBQVEsQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDM0MsVUFBVSxDQUFDLEVBQUUsR0FBRyx3QkFBd0IsQ0FBQztJQUN6QyxVQUFVLENBQUMsWUFBWSxDQUFDLGtCQUFrQixFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBQzNELFVBQVUsQ0FBQyxLQUFLLENBQUMsT0FBTztRQUN0Qix1REFBdUQsQ0FBQztJQUMxRCxRQUFRLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUN0QyxPQUFPLFVBQVUsQ0FBQztBQUNwQixDQUFDO0FBRUQsU0FBUyxRQUFRO0lBQ2YsSUFBSSxVQUFVLEVBQUU7UUFDZCxVQUFVLENBQUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxNQUFNLENBQUM7UUFDbEMsVUFBVSxDQUFDLFNBQVMsR0FBRyxFQUFFLENBQUM7S0FDM0I7SUFDRCxNQUFNLEVBQUUsR0FBRyxjQUFjLENBQUM7SUFDMUIsY0FBYyxHQUFHLElBQUksQ0FBQztJQUN0QixJQUFJLE9BQU8sRUFBRSxLQUFLLFVBQVUsRUFBRTtRQUM1QixJQUFJO1lBQUUsRUFBRSxFQUFFLENBQUM7U0FBRTtRQUFDLE9BQU8sRUFBRSxFQUFFLEVBQUUsVUFBVSxFQUFFO0tBQ3hDO0FBQ0gsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLE9BQU87SUFDekIsSUFBSSxDQUFDLFVBQVU7UUFBRSxPQUFPO0lBQ3hCLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxhQUFhLENBQUMsMEJBQTBCLENBQUMsQ0FBQztJQUNuRSxNQUFNLE1BQU0sR0FBRyxVQUFVLENBQUMsYUFBYSxDQUFDLHlCQUF5QixDQUFDLENBQUM7SUFDbkUsSUFBSSxLQUFLLEVBQUU7UUFDVCxLQUFLLENBQUMsV0FBVyxHQUFHLE9BQU8sQ0FBQztRQUM1QixLQUFLLENBQUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7S0FDMUI7SUFDRCxJQUFJLE1BQU07UUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxNQUFNLENBQUM7QUFDNUMsQ0FBQztBQUVELFNBQVMsV0FBVztJQUNsQixJQUFJLENBQUMsVUFBVTtRQUFFLE9BQU87SUFDeEIsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLGFBQWEsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQ25FLE1BQU0sTUFBTSxHQUFHLFVBQVUsQ0FBQyxhQUFhLENBQUMseUJBQXlCLENBQUMsQ0FBQztJQUNuRSxJQUFJLEtBQUs7UUFBRSxLQUFLLENBQUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxNQUFNLENBQUM7SUFDeEMsSUFBSSxNQUFNO1FBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO0FBQ3hDLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxPQUFPO0lBQ3pCLElBQUksQ0FBQyxVQUFVO1FBQUUsT0FBTztJQUN4QixNQUFNLEVBQUUsR0FBRyxVQUFVLENBQUMsYUFBYSxDQUFDLDJCQUEyQixDQUFDLENBQUM7SUFDakUsSUFBSSxFQUFFLEVBQUU7UUFDTixFQUFFLENBQUMsV0FBVyxHQUFHLE9BQU8sSUFBSSxFQUFFLENBQUM7UUFDL0IsRUFBRSxDQUFDLEtBQUssQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztLQUMxQztBQUNILENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxDQUFDO0lBQ3BCLE9BQU8sTUFBTSxDQUFDLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1NBQzlCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDO1NBQ3RCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO1NBQ3JCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO1NBQ3JCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDO1NBQ3ZCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDNUIsQ0FBQztBQUVELGlFQUFpRTtBQUNqRSxpREFBaUQ7QUFDakQsK0NBQStDO0FBQy9DLHVEQUF1RDtBQUN2RCxTQUFTLFVBQVUsQ0FBQyxHQUFHO0lBQ3JCLElBQUksQ0FBQyxHQUFHO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDcEIsTUFBTSxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO0lBQ3BELE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUN2QixDQUFDO0FBRUQsU0FBUyxVQUFVLENBQUMsR0FBRztJQUNyQixJQUFJLENBQUMsR0FBRztRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ3BCLE1BQU0sQ0FBQyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztJQUM5QyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDdkIsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEdBQUc7SUFDdkIsSUFBSSxDQUFDLEdBQUc7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNwQixNQUFNLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDdEQsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQ3ZCLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUTtJQUM1QyxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQzlCLE9BQU8sUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksSUFBSSxJQUFJLE1BQU0sUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLElBQUksS0FBSyxDQUFDO0FBQzNFLENBQUM7QUFFRCw4Q0FBOEM7QUFDOUMsU0FBUyxnQkFBZ0IsQ0FBQyxJQUFJO0lBQzVCLE1BQU0sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDekQsTUFBTSxNQUFNLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDcEMsTUFBTSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2pELE9BQU8sR0FBRyxHQUFHLElBQUksTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxFQUFFLENBQUM7QUFDMUQsQ0FBQztBQUVELG9EQUFvRDtBQUNwRCxTQUFTLGlCQUFpQjtJQUN4QixNQUFNLE9BQU8sR0FBRyxFQUFFLENBQUM7SUFDbkIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEVBQUUsRUFBRTtRQUMzQixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsSUFBSSxFQUFFLEVBQUU7WUFDL0IsTUFBTSxLQUFLLEdBQUcsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzVFLE9BQU8sQ0FBQyxJQUFJLENBQUMsa0JBQWtCLEtBQUssS0FBSyxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7U0FDOUU7S0FDRjtJQUNELE9BQU8sT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUMxQixDQUFDO0FBRUQseUVBQXlFO0FBQ3pFLDBFQUEwRTtBQUMxRSxTQUFTLFNBQVMsQ0FBQyxJQUFJO0lBQ3JCLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDckIsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztJQUN6RCxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNsRCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDeEMsSUFBSSxPQUFPLEtBQUssRUFBRSxFQUFFO1FBQ2xCLE9BQU8sR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDO0tBQ3REO0lBQ0QsT0FBTyxHQUFHLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFDN0UsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLFNBQVMsRUFBRSxZQUFZO0lBQzFDLFNBQVMsQ0FBQyxTQUFTO1FBQ2pCLHlHQUF5RztZQUN2RyxxV0FBcVc7WUFDblcsOEhBQThIO1lBQzlILHVIQUF1SDtZQUN2SCxzRkFBc0Y7WUFDdEYsZ0xBQWdMO1lBQ2hMLG9EQUFvRDtZQUNsRCx5QkFBeUI7WUFDdkIsc0VBQXNFO1lBQ3RFLCtLQUErSztZQUNqTCxRQUFRO1lBQ1IsdUJBQXVCO1lBQ3JCLHNFQUFzRTtZQUN0RSxtS0FBbUs7WUFDakssaUJBQWlCLEVBQUU7WUFDckIsV0FBVztZQUNiLFFBQVE7WUFDUiwyQkFBMkI7WUFDekIsMEVBQTBFO1lBQzFFLHVLQUF1SztZQUNySyxvQ0FBb0M7WUFDcEMsNkNBQTZDO1lBQzdDLG9DQUFvQztZQUNwQyxvQ0FBb0M7WUFDcEMsb0NBQW9DO1lBQ3RDLFdBQVc7WUFDYixRQUFRO1lBQ1YsUUFBUTtZQUNSLDZGQUE2RjtZQUM3Riw2VEFBNlQ7WUFDN1QsMEVBQTBFO1lBQ3hFLDZGQUE2RjtZQUM3RixpTUFBaU07WUFDbk0sUUFBUTtZQUNSLG9HQUFvRztZQUNwRywrSEFBK0g7WUFDN0gsa0hBQWtIO1lBQ2xILHdJQUF3STtZQUN4SSx1TEFBdUw7WUFDekwsUUFBUTtZQUNWLFFBQVE7WUFDVixRQUFRLENBQUM7SUFFWCxNQUFNLFFBQVEsR0FBSyxTQUFTLENBQUMsYUFBYSxDQUFDLDZCQUE2QixDQUFDLENBQUM7SUFDMUUsTUFBTSxPQUFPLEdBQU0sU0FBUyxDQUFDLGFBQWEsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQ3ZFLE1BQU0sTUFBTSxHQUFPLFNBQVMsQ0FBQyxhQUFhLENBQUMseUJBQXlCLENBQUMsQ0FBQztJQUN0RSxNQUFNLE1BQU0sR0FBTyxTQUFTLENBQUMsYUFBYSxDQUFDLHlCQUF5QixDQUFDLENBQUM7SUFDdEUsTUFBTSxVQUFVLEdBQUcsU0FBUyxDQUFDLGFBQWEsQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO0lBQzFFLE1BQU0sTUFBTSxHQUFPLFNBQVMsQ0FBQyxhQUFhLENBQUMsZ0NBQWdDLENBQUMsQ0FBQztJQUM3RSxNQUFNLFFBQVEsR0FBSyxTQUFTLENBQUMsYUFBYSxDQUFDLDJCQUEyQixDQUFDLENBQUM7SUFFeEUsTUFBTSxLQUFLLEdBQUc7UUFDWixZQUFZO1FBQ1osUUFBUSxFQUFFLEVBQUU7UUFDWixTQUFTLEVBQUUsRUFBRTtRQUNiLE9BQU8sRUFBRSxLQUFLO1FBQ2QsVUFBVSxFQUFFLEtBQUs7S0FDbEIsQ0FBQztJQUVGLFNBQVMsV0FBVyxDQUFDLE9BQU87UUFDMUIsT0FBTyxDQUFDLFFBQVEsR0FBRyxDQUFDLE9BQU8sQ0FBQztRQUM1QixNQUFNLENBQUMsUUFBUSxHQUFHLENBQUMsT0FBTyxDQUFDO1FBQzNCLE1BQU0sQ0FBQyxRQUFRLEdBQUcsQ0FBQyxPQUFPLENBQUM7UUFDM0IsVUFBVSxDQUFDLFFBQVEsR0FBRyxDQUFDLE9BQU8sQ0FBQztRQUMvQixNQUFNLENBQUMsWUFBWSxDQUFDLGlCQUFpQixFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNuRSxRQUFRLENBQUMsUUFBUSxHQUFHLENBQUMsT0FBTyxDQUFDO0lBQy9CLENBQUM7SUFFRCxTQUFTLGdCQUFnQjtRQUN2QixNQUFNLElBQUksR0FBRyxTQUFTLENBQUMsYUFBYSxDQUFDLDhCQUE4QixDQUFDLENBQUM7UUFDckUsSUFBSSxDQUFDLElBQUk7WUFBRSxPQUFPO1FBQ2xCLElBQUksS0FBSyxDQUFDLFNBQVMsQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFO1lBQ2hDLElBQUksQ0FBQyxXQUFXLEdBQUcsd0JBQXdCLENBQUM7WUFDNUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsTUFBTSxDQUFDO1lBQzFCLE9BQU87U0FDUjtRQUNELElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQztRQUMxQixJQUFJLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQzVDLHVGQUF1RjtZQUNyRixxRUFBcUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJO1lBQ3pHLFNBQVMsV0FBVyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksS0FBSyxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsU0FBUztZQUM1RSxVQUFVLENBQ1gsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDWCxJQUFJLENBQUMsZ0JBQWdCLENBQUMsa0NBQWtDLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLEVBQUU7WUFDckUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFO2dCQUNsQyxNQUFNLEdBQUcsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7Z0JBQzFELElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUU7b0JBQzlDLEtBQUssQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQztpQkFDbkQ7WUFDSCxDQUFDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELFNBQVMsV0FBVyxDQUFDLEtBQUs7UUFDeEIsS0FBSyxDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUM7UUFDckIsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ2xCLElBQUksS0FBSyxFQUFFO1lBQ1QsSUFBSSxLQUFLLENBQUMsS0FBSztnQkFBZSxPQUFPLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDbEUsSUFBSSxLQUFLLENBQUMsa0JBQWtCLEVBQUU7Z0JBQzVCLE1BQU0sQ0FBQyxLQUFLLEdBQUcsVUFBVSxDQUFDLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO2dCQUNwRCxNQUFNLE9BQU8sR0FBRyxTQUFTLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUM7Z0JBQ2hFLElBQUksT0FBTyxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLEtBQUssT0FBTyxDQUFDLEVBQUU7b0JBQ3hFLE1BQU0sQ0FBQyxLQUFLLEdBQUcsT0FBTyxDQUFDO2lCQUN4QjtnQkFDRCxLQUFLLENBQUMsUUFBUSxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsa0JBQWtCLENBQUMsQ0FBQzthQUN6RDtZQUNELElBQUksT0FBTyxLQUFLLENBQUMsZ0JBQWdCLEtBQUssUUFBUSxFQUFFO2dCQUM5QyxNQUFNLEdBQUcsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLGdCQUFnQixDQUFDLENBQUM7Z0JBQzNDLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQUssS0FBSyxHQUFHLENBQUMsRUFBRTtvQkFDN0QsVUFBVSxDQUFDLEtBQUssR0FBRyxHQUFHLENBQUM7aUJBQ3hCO2FBQ0Y7WUFDRCxJQUFJLEtBQUssQ0FBQyxXQUFXO2dCQUFTLE1BQU0sQ0FBQyxTQUFTLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUMzRSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxTQUFTLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtnQkFDaEUsS0FBSyxDQUFDLFNBQVMsR0FBRyxLQUFLLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7b0JBQzFDLEtBQUssRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUU7b0JBQ2pELElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO29CQUNsQyxPQUFPLEVBQUUsSUFBSTtpQkFDZCxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQ3pCLGdCQUFnQixFQUFFLENBQUM7YUFDcEI7WUFDRCxNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUMsYUFBYSxDQUFDLCtCQUErQixDQUFDLENBQUM7WUFDeEUsSUFBSSxLQUFLLENBQUMsVUFBVSxLQUFLLEtBQUssRUFBRTtnQkFDOUIsTUFBTSxDQUFDLFdBQVcsR0FBRywyQ0FBMkMsQ0FBQzthQUNsRTtpQkFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLEtBQUssTUFBTSxFQUFFO2dCQUN0QyxNQUFNLENBQUMsV0FBVyxHQUFHLHlCQUF5QixDQUFDO2FBQ2hEO1NBQ0Y7UUFDRCxVQUFVLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDbEIsQ0FBQztJQUVELEtBQUssVUFBVSxRQUFRO1FBQ3JCLElBQUksTUFBTSxHQUFHLElBQUksQ0FBQztRQUNsQixJQUFJO1lBQ0YsTUFBTSxHQUFHLE1BQU0sYUFBYSxDQUFDLFVBQVUsQ0FBQyxFQUFFLGNBQWMsRUFBRSxZQUFZLEVBQUUsQ0FBQyxDQUFDO1NBQzNFO1FBQUMsT0FBTyxFQUFFLEVBQUU7WUFDWCxNQUFNLEdBQUcsSUFBSSxDQUFDO1NBQ2Y7UUFDRCxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ1gsOERBQThEO1lBQzlELFVBQVUsQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUNmLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNsQixVQUFVLENBQUMsc0NBQXNDLENBQUMsQ0FBQztZQUNuRCxPQUFPLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDaEIsT0FBTztTQUNSO1FBQ0QsSUFBSSxNQUFNLENBQUMsS0FBSyxFQUFFO1lBQ2hCLHlEQUF5RDtZQUN6RCxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDcEIsVUFBVSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUN6QixPQUFPO1NBQ1I7UUFDRCxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdEIsQ0FBQztJQUVELEtBQUssVUFBVSxTQUFTO1FBQ3RCLElBQUksS0FBSyxDQUFDLFVBQVU7WUFBRSxPQUFPO1FBQzdCLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTztZQUFFLE9BQU8sQ0FBRSxvQkFBb0I7UUFFakQsV0FBVyxFQUFFLENBQUM7UUFDZCxNQUFNLEtBQUssR0FBRyxDQUFDLE9BQU8sQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDM0MsSUFBSSxDQUFDLEtBQUssRUFBRTtZQUNWLFVBQVUsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1lBQ2hDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUNoQixPQUFPO1NBQ1I7UUFDRCxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDO1FBQzdCLE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUM7UUFDN0IsSUFBSSxDQUFDLE9BQU8sRUFBRTtZQUNaLFVBQVUsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1lBQy9CLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUNmLE9BQU87U0FDUjtRQUNELElBQUksQ0FBQyxPQUFPLEVBQUU7WUFDWixVQUFVLENBQUMsa0JBQWtCLENBQUMsQ0FBQztZQUMvQixNQUFNLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDZixPQUFPO1NBQ1I7UUFDRCxNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsVUFBVSxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUNoRCxNQUFNLFFBQVEsR0FBRyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUNwRSxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsU0FBUzthQUM5QixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO2FBQ3RCLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUM7UUFFNUUsS0FBSyxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUM7UUFDeEIsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ25CLFVBQVUsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBRTlCLElBQUksTUFBTSxHQUFHLElBQUksQ0FBQztRQUNsQixJQUFJO1lBQ0YsTUFBTSxHQUFHLE1BQU0sYUFBYSxDQUFDLFdBQVcsQ0FBQztnQkFDdkMsY0FBYyxFQUFFLFlBQVk7Z0JBQzVCLEtBQUs7Z0JBQ0wsV0FBVyxFQUFFLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUU7Z0JBQzVDLFNBQVMsRUFBRSxRQUFRO2dCQUNuQixnQkFBZ0IsRUFBRSxRQUFRO2dCQUMxQixTQUFTO2dCQUNULGNBQWMsRUFBRSxjQUFjO2dCQUM5QixXQUFXLEVBQUUsSUFBSTthQUNsQixDQUFDLENBQUM7U0FDSjtRQUFDLE9BQU8sRUFBRSxFQUFFO1lBQ1gsTUFBTSxHQUFHLElBQUksQ0FBQztTQUNmO1FBRUQsS0FBSyxDQUFDLFVBQVUsR0FBRyxLQUFLLENBQUM7UUFDekIsVUFBVSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBRWYsSUFBSSxDQUFDLE1BQU0sRUFBRTtZQUNYLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNsQixVQUFVLENBQUMsaUNBQWlDLENBQUMsQ0FBQztZQUM5QyxPQUFPO1NBQ1I7UUFDRCxJQUFJLE1BQU0sQ0FBQyxLQUFLLEVBQUU7WUFDaEIsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2xCLFVBQVUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDekIsT0FBTztTQUNSO1FBRUQsNENBQTRDO1FBQzVDLElBQUksTUFBTSxDQUFDLFNBQVMsRUFBRTtZQUNwQixVQUFVLENBQUMsYUFBYSxNQUFNLENBQUMsU0FBUyxFQUFFLENBQUMsQ0FBQztTQUM3QzthQUFNO1lBQ0wsVUFBVSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1NBQ3hCO1FBQ0QsVUFBVSxDQUFDLEdBQUcsRUFBRSxDQUFDLFFBQVEsRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ3BDLENBQUM7SUFFRCxRQUFRLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLFVBQVUsQ0FBQztRQUM1QyxJQUFJLENBQUMsQ0FBQyxNQUFNLEtBQUssUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLFVBQVU7WUFBRSxRQUFRLEVBQUUsQ0FBQztJQUM3RCxDQUFDLENBQUMsQ0FBQztJQUVILFNBQVMsV0FBVyxDQUFDLENBQUM7UUFDcEIsSUFBSSxDQUFDLENBQUMsR0FBRyxLQUFLLFFBQVEsRUFBRTtZQUN0QixJQUFJLEtBQUssQ0FBQyxVQUFVO2dCQUFFLE9BQU87WUFDN0IsQ0FBQyxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQ3BCLFFBQVEsRUFBRSxDQUFDO1lBQ1gsT0FBTztTQUNSO1FBQ0QsSUFBSSxDQUFDLENBQUMsR0FBRyxLQUFLLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFO1lBQ2pELENBQUMsQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNuQixDQUFDLENBQUMsZUFBZSxFQUFFLENBQUM7WUFDcEIsU0FBUyxFQUFFLENBQUM7U0FDYjtJQUNILENBQUM7SUFDRCw4REFBOEQ7SUFDOUQsU0FBUyxDQUFDLGdCQUFnQixDQUFDLFNBQVMsRUFBRSxXQUFXLENBQUMsQ0FBQztJQUVuRCxRQUFRLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLFVBQVUsQ0FBQztRQUM1QyxDQUFDLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDbkIsU0FBUyxFQUFFLENBQUM7SUFDZCxDQUFDLENBQUMsQ0FBQztJQUVILENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsVUFBVSxFQUFFLE1BQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsRUFBRTtRQUN6RCxFQUFFLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBQzFDLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsV0FBVyxDQUFDLENBQUM7SUFDN0MsQ0FBQyxDQUFDLENBQUM7SUFFSCxpQ0FBaUM7SUFDakMsUUFBUSxFQUFFLENBQUM7QUFDYixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBUyxnQkFBZ0IsQ0FBQyxZQUFZLEVBQUUsT0FBTztJQUM3QyxJQUFJLENBQUMsWUFBWTtRQUFFLE9BQU8sY0FBYSxDQUFDLENBQUM7SUFDekMsUUFBUSxFQUFFLENBQUM7SUFDWCxNQUFNLFNBQVMsR0FBRyxnQkFBZ0IsRUFBRSxDQUFDO0lBQ3JDLGNBQWMsR0FBRyxDQUFDLE9BQU8sT0FBTyxLQUFLLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNsRSxTQUFTLENBQUMsS0FBSyxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7SUFDN0IsV0FBVyxDQUFDLFNBQVMsRUFBRSxZQUFZLENBQUMsQ0FBQztJQUNyQyxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDO0FBRUQsTUFBTSxDQUFDLE9BQU8sR0FBRyxFQUFFLGdCQUFnQixFQUFFLENBQUM7QUFDdEMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxnQkFBZ0IsR0FBRyxnQkFBZ0IsQ0FBQztBQUNuRCxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sR0FBRyxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLENBQUMifQ==