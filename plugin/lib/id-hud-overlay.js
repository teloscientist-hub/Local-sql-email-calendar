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
    if (_container)
        return _container;
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
        }
        else {
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
    }
    catch (err) {
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
        if (row && row.rfc_message_id)
            byRfc.set(row.rfc_message_id, row);
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
        return (`<div class="mml-idhud-row" data-row-idx="${idx}" style="border-top:1px solid #eee;padding:8px 0;">` +
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
            `</div>`);
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
        if (e.target === backdrop)
            _dismiss();
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
        return function () { };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWQtaHVkLW92ZXJsYXkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaWQtaHVkLW92ZXJsYXkuanN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YseUVBQXlFO0FBQ3pFLDRFQUE0RTtBQUM1RSxnRUFBZ0U7QUFDaEUsRUFBRTtBQUNGLDBFQUEwRTtBQUMxRSwyREFBMkQ7QUFDM0QsRUFBRTtBQUNGLGNBQWM7QUFDZCxvREFBb0Q7QUFDcEQsd0VBQXdFO0FBQ3hFLDZFQUE2RTtBQUM3RSxFQUFFO0FBQ0YsdURBQXVEO0FBRXZELElBQUksVUFBVSxHQUFHLElBQUksQ0FBQztBQUV0QixTQUFTLGdCQUFnQjtJQUN2QixJQUFJLFVBQVU7UUFBRSxPQUFPLFVBQVUsQ0FBQztJQUNsQyxVQUFVLEdBQUcsUUFBUSxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUMzQyxVQUFVLENBQUMsRUFBRSxHQUFHLG1CQUFtQixDQUFDO0lBQ3BDLFVBQVUsQ0FBQyxZQUFZLENBQUMsa0JBQWtCLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDdEQsVUFBVSxDQUFDLEtBQUssQ0FBQyxPQUFPO1FBQ3RCLHVEQUF1RCxDQUFDO0lBQzFELFFBQVEsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ3RDLE9BQU8sVUFBVSxDQUFDO0FBQ3BCLENBQUM7QUFFRCxTQUFTLFFBQVE7SUFDZixJQUFJLFVBQVUsRUFBRTtRQUNkLFVBQVUsQ0FBQyxLQUFLLENBQUMsT0FBTyxHQUFHLE1BQU0sQ0FBQztRQUNsQyxVQUFVLENBQUMsU0FBUyxHQUFHLEVBQUUsQ0FBQztLQUMzQjtJQUNELFFBQVEsQ0FBQyxtQkFBbUIsQ0FBQyxTQUFTLEVBQUUsVUFBVSxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQzVELENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxDQUFDO0lBQ25CLElBQUksQ0FBQyxDQUFDLEdB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