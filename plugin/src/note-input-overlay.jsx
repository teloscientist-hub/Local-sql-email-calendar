// note-input-overlay.jsx
//
// Phase 3 — small text-input overlay summoned by Ctrl+Cmd+N. Writes
// the typed note onto the most recent `message_ratings` row for the
// focused thread's latest message via /add-note.
//
// Vanilla DOM implementation: Mailspring's plugin sandbox doesn't
// expose `react-dom` as a require-able module, and pulling in our own
// React+ReactDOM creates duplicate-React-instance hazards. The overlay
// is simple enough that a plain document.createElement approach is
// cleaner than fighting the plugin loader. (Original React+portal
// version retired 2026-05-09 after package activation failure with
// "Cannot find module 'react-dom'".)
//
// Public API stays the same:
//   openNoteOverlay(rfcMessageId, onClose?) → close fn
// Calling twice closes the prior instance before opening anew.

const sidecarClient = require('./sidecar-client');

let _container = null;
let _activeInput = null;
let _activeOnClose = null;

function _ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.id = 'mml-note-input-portal';
  _container.setAttribute('data-mml-overlay', 'note-input');
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
  _activeInput = null;
  const cb = _activeOnClose;
  _activeOnClose = null;
  if (typeof cb === 'function') {
    try { cb(); } catch (_e) { /* noop */ }
  }
}

function _showError(message) {
  if (!_container) return;
  const errEl = _container.querySelector('.mml-note-overlay-error');
  const hintEl = _container.querySelector('.mml-note-overlay-hint');
  if (errEl) {
    errEl.textContent = message;
    errEl.style.display = '';
  }
  if (hintEl) hintEl.style.display = 'none';
}

function _clearError() {
  if (!_container) return;
  const errEl = _container.querySelector('.mml-note-overlay-error');
  const hintEl = _container.querySelector('.mml-note-overlay-hint');
  if (errEl) errEl.style.display = 'none';
  if (hintEl) hintEl.style.display = '';
}

function _renderInto(container, rfcMessageId) {
  container.innerHTML =
    '<div class="mml-note-overlay-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.25);">' +
      '<div class="mml-note-overlay" role="dialog" aria-label="Add note" style="position:absolute;top:30%;left:50%;transform:translateX(-50%);background:#fff;padding:14px 18px;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,0.2);width:360px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">' +
        '<div class="mml-note-overlay-header" style="font-weight:600;margin-bottom:8px;">Add note</div>' +
        '<input type="text" class="mml-note-overlay-input" placeholder="Why this rating? (Esc to cancel)" style="width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;outline:none;font-size:13px;"/>' +
        '<div class="mml-note-overlay-footer" style="margin-top:8px;font-size:12px;color:#666;">' +
          '<span class="mml-note-overlay-hint">Enter to save · Esc to cancel</span>' +
          '<span class="mml-note-overlay-error" style="display:none;color:#c00;"></span>' +
        '</div>' +
      '</div>' +
    '</div>';

  const backdrop = container.querySelector('.mml-note-overlay-backdrop');
  const input = container.querySelector('.mml-note-overlay-input');
  _activeInput = input;

  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) _dismiss();
  });

  input.addEventListener('input', function () {
    _clearError();
  });

  input.addEventListener('keydown', async function (e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      _dismiss();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const note = input.value;
      input.disabled = true;
      let result = null;
      try {
        result = await sidecarClient.addNote({
          rfc_message_id: rfcMessageId,
          note: note,
        });
      } catch (err) {
        result = null;
      }
      if (!result) {
        _showError('sidecar unreachable');
        input.disabled = false;
        return;
      }
      if (result.error) {
        _showError(result.error);
        input.disabled = false;
        return;
      }
      sidecarClient.bustThreadCache([rfcMessageId]);
      _dismiss();
    }
  });

  // Async focus to let the container's display flip to visible first.
  setTimeout(function () {
    if (_activeInput === input) input.focus();
  }, 0);
}

/**
 * Open the overlay for a given RFC-822 Message-ID. Returns a close fn.
 * Idempotent — calling twice closes the prior instance before opening
 * the new one.
 */
function openNoteOverlay(rfcMessageId, onClose) {
  if (!rfcMessageId) {
    return function () {};
  }
  // Close any prior instance to keep state clean.
  _dismiss();
  const container = _ensureContainer();
  _activeOnClose = (typeof onClose === 'function') ? onClose : null;
  container.style.display = '';
  _renderInto(container, rfcMessageId);
  return _dismiss;
}

module.exports = { openNoteOverlay };
module.exports.openNoteOverlay = openNoteOverlay;
module.exports.default = { openNoteOverlay: openNoteOverlay };
