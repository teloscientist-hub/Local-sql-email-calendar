// id-hud-overlay.jsx
//
// Small HUD overlay summoned by right-click on a thread row. Lists every
// RFC-822 Message-ID in the thread and its warehouse id, with click-to-copy
// on each row. Used for debugging /thread calls and ad-hoc SQL.
//
// Vanilla DOM — same constraint as the other overlays (note-input, route-
// confirm): the plugin sandbox doesn't expose `react-dom`.
//
// Public API:
//   openIdHudOverlay(rfcIds, lookupRows) → close fn
//     rfcIds:     array of RFC-822 Message-IDs (always shown, in order)
//     lookupRows: array of /message-lookup rows (may be shorter / unordered)
//
// Anchored center-top; Esc or click-outside dismisses.

let _container = null;

function _ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.id = 'mml-id-hud-portal';
  _container.setAttribute('data-mml-overlay', 'id-hud');
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
  document.removeEventListener('keydown', _onKeydown, true);
}

function _onKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    _dismiss();
  }
}

function _copy(text, flashEl) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      // Fallback for older Electron: textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (flashEl) {
      const original = flashEl.textContent;
      flashEl.textContent = 'copied';
      flashEl.style.color = '#0a7';
      setTimeout(() => {
        flashEl.textContent = original;
        flashEl.style.color = '';
      }, 900);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] id-hud copy failed:', err);
  }
}

function _escape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _renderInto(container, rfcIds, lookupRows) {
  const byRfc = new Map();
  for (const row of (lookupRows || [])) {
    if (row && row.rfc_message_id) byRfc.set(row.rfc_message_id, row);
  }

  const rowsHtml = rfcIds.map((rfc, idx) => {
    const meta = byRfc.get(rfc);
    const wid = meta ? meta.warehouse_id : null;
    const subj = meta ? meta.subject : null;
    const cluster = meta && meta.cluster ? `${meta.cluster} (#${meta.cluster_id})` : null;
    const rating = (meta && meta.rating != null) ? `rating=${meta.rating}` : null;

    const metaLine = [
      wid != null ? `warehouse=${wid}` : 'not in warehouse',
      cluster,
      rating,
    ].filter(Boolean).join(' · ');

    return (
      `<div class="mml-idhud-row" data-row-idx="${idx}" style="border-top:1px solid #eee;padding:8px 0;">` +
        (subj
          ? `<div style="font-weight:600;font-size:12px;color:#333;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escape(subj)}</div>`
          : '') +
        `<div style="display:flex;align-items:center;gap:6px;">` +
          `<code class="mml-idhud-rfc" data-rfc="${_escape(rfc)}" title="click to copy" style="flex:1;font-size:11px;color:#06c;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#f5f9ff;padding:3px 6px;border-radius:3px;">${_escape(rfc)}</code>` +
          `<span class="mml-idhud-rfc-status" style="font-size:11px;color:#888;width:56px;text-align:right;">copy rfc</span>` +
        `</div>` +
        (wid != null
          ? `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">` +
              `<code class="mml-idhud-wid" data-wid="${wid}" title="click to copy" style="flex:1;font-size:11px;color:#444;cursor:pointer;background:#f7f7f7;padding:3px 6px;border-radius:3px;">${wid}</code>` +
              `<span class="mml-idhud-wid-status" style="font-size:11px;color:#888;width:56px;text-align:right;">copy id</span>` +
            `</div>`
          : '') +
        (metaLine
          ? `<div style="margin-top:4px;font-size:11px;color:#888;">${_escape(metaLine)}</div>`
          : '') +
      `</div>`
    );
  }).join('');

  const allRfcs = rfcIds.join(',');

  container.innerHTML =
    `<div class="mml-idhud-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.18);">` +
      `<div class="mml-idhud-panel" role="dialog" aria-label="Message IDs" style="position:absolute;top:60px;left:50%;transform:translateX(-50%);background:#fff;padding:14px 18px;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,0.2);width:560px;max-height:70vh;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">` +
        `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">` +
          `<div style="font-weight:600;font-size:13px;">Message IDs (${rfcIds.length})</div>` +
          `<button class="mml-idhud-copy-all" style="font-size:11px;padding:3px 8px;border:1px solid #ccc;border-radius:3px;background:#fafafa;cursor:pointer;">copy all rfc</button>` +
        `</div>` +
        `<div style="font-size:11px;color:#888;margin-bottom:4px;">Esc or click outside to close</div>` +
        rowsHtml +
      `</div>` +
    `</div>`;

  const backdrop = container.querySelector('.mml-idhud-backdrop');
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) _dismiss();
  });

  container.querySelectorAll('.mml-idhud-rfc').forEach((el) => {
    el.addEventListener('click', () => {
      const status = el.parentElement.querySelector('.mml-idhud-rfc-status');
      _copy(el.getAttribute('data-rfc'), status);
    });
  });
  container.querySelectorAll('.mml-idhud-wid').forEach((el) => {
    el.addEventListener('click', () => {
      const status = el.parentElement.querySelector('.mml-idhud-wid-status');
      _copy(el.getAttribute('data-wid'), status);
    });
  });
  const copyAll = container.querySelector('.mml-idhud-copy-all');
  if (copyAll) {
    copyAll.addEventListener('click', () => _copy(allRfcs, copyAll));
  }

  document.addEventListener('keydown', _onKeydown, true);
}

function openIdHudOverlay(rfcIds, lookupRows) {
  if (!Array.isArray(rfcIds) || rfcIds.length === 0) {
    return function () {};
  }
  _dismiss();
  const container = _ensureContainer();
  container.style.display = '';
  _renderInto(container, rfcIds, lookupRows || []);
  return _dismiss;
}

module.exports = { openIdHudOverlay };
module.exports.openIdHudOverlay = openIdHudOverlay;
module.exports.default = { openIdHudOverlay };
