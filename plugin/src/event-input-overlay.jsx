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
  if (_container) return _container;
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
    try { cb(); } catch (_e) { /* noop */ }
  }
}

function _showError(message) {
  if (!_container) return;
  const errEl = _container.querySelector('.mml-event-overlay-error');
  const hintEl = _container.querySelector('.mml-event-overlay-hint');
  if (errEl) {
    errEl.textContent = message;
    errEl.style.display = '';
  }
  if (hintEl) hintEl.style.display = 'none';
}

function _clearError() {
  if (!_container) return;
  const errEl = _container.querySelector('.mml-event-overlay-error');
  const hintEl = _container.querySelector('.mml-event-overlay-hint');
  if (errEl) errEl.style.display = 'none';
  if (hintEl) hintEl.style.display = '';
}

function _setStatus(message) {
  if (!_container) return;
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
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function _isoToTime(iso) {
  if (!iso) return '';
  const m = String(iso).match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

function _isoTzOffset(iso) {
  if (!iso) return '';
  const m = String(iso).match(/(Z|[+\-]\d{2}:?\d{2})$/);
  return m ? m[1] : '';
}

function _combineDateTime(date, time, tzOffset) {
  if (!date || !time) return '';
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
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return '';
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

  const backdrop   = container.querySelector('.mml-event-overlay-backdrop');
  const titleEl    = container.querySelector('.mml-event-overlay-title');
  const dateEl     = container.querySelector('.mml-event-overlay-date');
  const timeEl     = container.querySelector('.mml-event-overlay-time');
  const durationEl = container.querySelector('.mml-event-overlay-duration');
  const descEl     = container.querySelector('.mml-event-overlay-description');
  const submitEl   = container.querySelector('.mml-event-overlay-submit');

  const state = {
    rfcMessageId,
    tzOffset: '',
    attendees: [],   // [{email, name, checked}]
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
    if (!wrap) return;
    if (state.attendees.length === 0) {
      wrap.textContent = 'no attendees suggested';
      wrap.style.color = '#888';
      return;
    }
    wrap.style.color = '#222';
    wrap.innerHTML = state.attendees.map((a, i) =>
      '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;">' +
        `<input type="checkbox" class="mml-event-overlay-attendee" data-i="${i}" ${a.checked ? 'checked' : ''}/>` +
        `<span>${_escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)}</span>` +
      '</label>'
    ).join('');
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
      if (draft.title)              titleEl.value = String(draft.title);
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
      if (draft.description)        descEl.innerHTML = String(draft.description);
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
      } else if (draft.confidence === 'high') {
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
    } catch (_e) {
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
    if (state.submitting) return;
    if (!state.drafted) return;  // hasn't loaded yet

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
    } catch (_e) {
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
    } else {
      _setStatus('Created.');
    }
    setTimeout(() => _dismiss(), 900);
  }

  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop && !state.submitting) _dismiss();
  });

  function _keyHandler(e) {
    if (e.key === 'Escape') {
      if (state.submitting) return;
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
  if (!rfcMessageId) return function () {};
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
