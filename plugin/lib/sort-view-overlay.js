// sort-view-overlay.jsx
//
// Cmd+Option+V — open a sortable list of threads currently in the active
// Mailspring perspective. Same vanilla-DOM pattern as
// route-confirm-overlay.jsx (Mailspring's plugin sandbox doesn't expose
// react-dom, and pulling our own would duplicate React instances).
//
// Flow:
//   1. Handler grabs threads from ThreadListStore.dataSource() and resolves
//      each one to an RFC-822 Message-ID (sidecar-client.rfcIdsForThread).
//   2. Handler calls /threads-enrich with the full list of RFC ids.
//   3. Overlay renders the enrichment as a clickable table with column
//      headers. Default sort: sender_name asc. Click a header to re-sort.
//   4. Click a row → Actions.setFocus({collection:'thread', item:thread}) →
//      Mailspring focuses that thread; overlay dismisses.
//   5. Esc or backdrop click dismisses without focusing.
// ThreadListStore is NOT exported via mailspring-exports — destructuring it
// silently yields undefined (other plugin files have the same dead import).
// We use only Actions here and resolve thread offsets from the threads array
// the handler already passes us (perspective order from Layer B).
const { Actions } = require('mailspring-exports');
let _container = null;
let _state = 'idle'; // 'idle' | 'loading' | 'ready'
let _rows = []; // [{ thread, enriched, senderGroupKey, senderGroupSize }]
let _threadIndexById = new Map(); // thread.id -> offset in perspective order
let _sortKey = 'rating';
let _sortDir = 'desc';
let _docKeyHandler = null;
// -------------------------------------------------------------------------
// Sort definitions
// Sources where the owner *explicitly* chose the rating himself:
//   - 'manual' : Ctrl+Opt+0..9 keystroke wrote a row in message_ratings
//   - 'csv'    : entry in contacts_to_rate.csv (the spreadsheet)
//
// Deliberately stricter than the inbox PersonBand filter, which also
// includes 'priority_friend' and 'family'. Those are Python pattern
// matches (sender_classifications flag, family cluster_id=3) — the owner
// did not assign them per-rating, so they belong in the LLM/pattern
// column visualization, not the "you decided" column.
//
// Values are the lowercase strings emitted by ratings.RatingSource enum
// on the sidecar (see ratings.py:32-41).
const MARK_OWNED_RATING_SOURCES = ['manual', 'csv'];
function _markOwnedRating(e) {
    if (!e || e.rating == null)
        return null;
    const src = (e.rating_source || '').toLowerCase();
    if (MARK_OWNED_RATING_SOURCES.indexOf(src) === -1)
        return null;
    if (e.rating <= 0)
        return null;
    return e.rating;
}
const SORT_COLUMNS = {
    sender: { label: 'Sender', key: (r) => _displaySender(r.enriched).toLowerCase() },
    count: { label: 'Cnt', key: (r) => r.senderGroupSize, defaultDir: 'desc' },
    engagement: { label: 'Engagement', key: (r) => (r.enriched.sender_send_count || 0), defaultDir: 'desc' },
    to_addr: { label: 'Sent to', key: (r) => (r.enriched.to_me_addr || '').toLowerCase() },
    subject: { label: 'Subject', key: (r) => (r.enriched.subject || '').toLowerCase() },
    date: { label: 'Date', key: (r) => (r.enriched.received_date || ''), defaultDir: 'desc' },
    rating: { label: 'Rate', key: (r) => { const v = _markOwnedRating(r.enriched); return v == null ? -1 : v; }, defaultDir: 'desc' },
    llm_rate: { label: 'LLM Rate', key: (r) => (r.enriched.suggested_rating == null ? -1 : r.enriched.suggested_rating), defaultDir: 'desc' },
};
function _displaySender(e) {
    if (!e)
        return '(unknown)';
    const name = (e.sender_name || '').trim();
    if (name)
        return name;
    return (e.sender_addr || '(unknown)').trim();
}
function _escape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function _shortDate(iso) {
    if (!iso)
        return '';
    // received_date format: "2026-05-11T18:58:27+00:00" or similar
    const d = new Date(iso);
    if (isNaN(d.getTime()))
        return iso.slice(0, 10);
    const now = new Date();
    const ms = now - d;
    const day = 24 * 60 * 60 * 1000;
    if (ms < 0)
        return d.toISOString().slice(0, 10);
    if (ms < day) {
        const h = Math.floor(ms / (60 * 60 * 1000));
        if (h === 0)
            return 'now';
        return h + 'h';
    }
    const days = Math.floor(ms / day);
    if (days < 30)
        return days + 'd';
    if (days < 365)
        return Math.floor(days / 7) + 'w';
    return Math.floor(days / 365) + 'y';
}
function _shortAddr(addr) {
    if (!addr)
        return '';
    const a = String(addr);
    if (a.length <= 22)
        return a;
    return a.slice(0, 20) + '…';
}
// -------------------------------------------------------------------------
// Container
function _ensureContainer() {
    if (_container)
        return _container;
    _container = document.createElement('div');
    _container.id = 'mml-sort-view-portal';
    _container.setAttribute('data-mml-overlay', 'sort-view');
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
    _rows = [];
}
// -------------------------------------------------------------------------
// Computing groups + sorted rows
function _computeRows(enrichedList, threadsByRfc) {
    // First pass: count how many rows share each sender key.
    const groupCounts = new Map();
    for (const e of enrichedList) {
        const key = _displaySender(e).toLowerCase();
        groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
    }
    const rows = [];
    for (const e of enrichedList) {
        const t = threadsByRfc.get(e.rfc_message_id);
        if (!t)
            continue;
        const groupKey = _displaySender(e).toLowerCase();
        rows.push({
            thread: t,
            enriched: e,
            senderGroupKey: groupKey,
            senderGroupSize: groupCounts.get(groupKey) || 1,
        });
    }
    return rows;
}
function _sortRows(rows) {
    const col = SORT_COLUMNS[_sortKey] || SORT_COLUMNS.sender;
    const dir = _sortDir === 'desc' ? -1 : 1;
    const tiebreakDate = (r) => (r.enriched.received_date || '');
    return [...rows].sort((a, b) => {
        const av = col.key(a);
        const bv = col.key(b);
        if (av < bv)
            return -1 * dir;
        if (av > bv)
            return 1 * dir;
        // Secondary: by date descending within ties so newest float to top.
        const ad = tiebreakDate(a);
        const bd = tiebreakDate(b);
        if (ad < bd)
            return 1;
        if (ad > bd)
            return -1;
        return 0;
    });
}
// -------------------------------------------------------------------------
// Rendering
// Detect Mailspring's active theme by inspecting body classes added by
// theme-manager.js (always `theme-<name>`). Anything matching the known
// dark themes counts; otherwise fall back to OS-level prefers-color-scheme.
function _isDarkTheme() {
    try {
        const cls = (document.body && document.body.className) || '';
        if (/\btheme-ui-dark\b|\btheme-ui-darkside\b/.test(cls))
            return true;
        if (/\btheme-ui-light\b/.test(cls))
            return false;
    }
    catch (_) { /* noop */ }
    try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
            return true;
    }
    catch (_) { /* noop */ }
    return false;
}
function _styleBlock() {
    const dark = _isDarkTheme();
    const c = dark ? {
        shellBg: '#1f2126',
        shellShadow: '0 12px 48px rgba(0,0,0,0.6)',
        border: '#33363d',
        rowBorder: '#2a2c32',
        headBg: '#26282e',
        title: '#e6e6e6',
        meta: '#8a8f99',
        hint: '#8a8f99',
        thColor: '#9aa0aa',
        thHover: '#f0f0f0',
        thActive: '#5aa0e6',
        sender: '#e6e6e6',
        senderMuted: '#5a5e66',
        cell: '#c4c8d0',
        numMuted: '#8a8f99',
        date: '#8a8f99',
        rowHover: '#2a323e',
        pillText: '#fff',
        pillBg: '#4a4e57',
        backdrop: 'rgba(0,0,0,0.55)',
        emptyText: '#8a8f99',
    } : {
        shellBg: '#ffffff',
        shellShadow: '0 12px 48px rgba(0,0,0,0.32)',
        border: '#e8e8e8',
        rowBorder: '#f0f0f0',
        headBg: '#f5f5f5',
        title: '#222222',
        meta: '#888888',
        hint: '#888888',
        thColor: '#666666',
        thHover: '#222222',
        thActive: '#1d6fbf',
        sender: '#222222',
        senderMuted: '#aaaaaa',
        cell: '#444444',
        numMuted: '#666666',
        date: '#888888',
        rowHover: '#f3f8fd',
        pillText: '#ffffff',
        pillBg: '#888888',
        backdrop: 'rgba(0,0,0,0.18)',
        emptyText: '#888888',
    };
    return ('<style>' +
        '#mml-sort-view-portal .mml-sv-backdrop{background:' + c.backdrop + ' !important;}' +
        '.mml-sv-shell{position:absolute;top:36px;left:18px;right:18px;bottom:18px;' +
        'background:' + c.shellBg + ';border-radius:8px;box-shadow:' + c.shellShadow + ';' +
        'display:flex;flex-direction:column;overflow:hidden;}' +
        '.mml-sv-head{padding:10px 14px;border-bottom:1px solid ' + c.border + ';' +
        'display:flex;align-items:center;gap:14px;flex-shrink:0;}' +
        '.mml-sv-title{font-size:13px;font-weight:600;color:' + c.title + ';}' +
        '.mml-sv-meta{font-size:11px;color:' + c.meta + ';}' +
        '.mml-sv-spacer{flex:1;}' +
        '.mml-sv-hint{font-size:11px;color:' + c.hint + ';}' +
        '.mml-sv-thead{display:grid;grid-template-columns:200px 40px 60px 70px 36px 90px 200px 1fr;' +
        'gap:8px;padding:6px 14px;background:' + c.headBg + ';border-bottom:1px solid ' + c.border + ';' +
        'font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:' + c.thColor + ';flex-shrink:0;}' +
        '.mml-sv-th{cursor:pointer;user-select:none;}' +
        '.mml-sv-th:hover{color:' + c.thHover + ';}' +
        '.mml-sv-th.active{color:' + c.thActive + ';font-weight:600;}' +
        '.mml-sv-body{flex:1;overflow-y:auto;}' +
        '.mml-sv-row{display:grid;grid-template-columns:200px 40px 60px 70px 36px 90px 200px 1fr;' +
        'gap:8px;padding:6px 14px;border-bottom:1px solid ' + c.rowBorder + ';cursor:pointer;' +
        'font-size:12px;align-items:center;}' +
        '.mml-sv-row:hover{background:' + c.rowHover + ';}' +
        '.mml-sv-sender{font-weight:500;color:' + c.sender + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.mml-sv-sender.muted{color:' + c.senderMuted + ';font-weight:400;}' +
        '.mml-sv-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + c.cell + ';}' +
        '.mml-sv-cnt{font-variant-numeric:tabular-nums;color:' + c.numMuted + ';text-align:right;}' +
        '.mml-sv-eng{font-variant-numeric:tabular-nums;color:' + c.numMuted + ';text-align:right;}' +
        '.mml-sv-date{font-variant-numeric:tabular-nums;color:' + c.date + ';text-align:right;font-size:11px;}' +
        '.mml-sv-rate{text-align:right;font-variant-numeric:tabular-nums;}' +
        '.mml-sv-rate-pill{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;color:' + c.pillText + ';background:' + c.pillBg + ';}' +
        '.mml-sv-llm{text-align:right;font-variant-numeric:tabular-nums;}' +
        '.mml-sv-llm-pill{display:inline-block;min-width:18px;padding:1px 6px;font-size:10px;font-weight:700;color:' + c.pillText + ';background:' + c.pillBg + ';' +
        'clip-path:polygon(15% 0%, 85% 0%, 100% 50%, 85% 100%, 15% 100%, 0% 50%);' +
        '-webkit-clip-path:polygon(15% 0%, 85% 0%, 100% 50%, 85% 100%, 15% 100%, 0% 50%);}' +
        '.mml-sv-empty{padding:40px;text-align:center;color:' + c.emptyText + ';font-size:13px;}' +
        '.mml-sv-loading{padding:40px;text-align:center;color:' + c.emptyText + ';font-size:13px;}' +
        '</style>');
}
function _renderLoading(threadCount) {
    if (!_container)
        return;
    _container.innerHTML =
        _styleBlock() +
            '<div class="mml-sv-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.18);">' +
            '<div class="mml-sv-shell">' +
            '<div class="mml-sv-head">' +
            '<div class="mml-sv-title">Sort View</div>' +
            '<div class="mml-sv-meta">' + threadCount + ' threads in current perspective</div>' +
            '<div class="mml-sv-spacer"></div>' +
            '<div class="mml-sv-hint">Esc to dismiss</div>' +
            '</div>' +
            '<div class="mml-sv-loading">Loading enrichment from sidecar…</div>' +
            '</div>' +
            '</div>';
    _wireBackdrop();
}
function _renderEmpty(reason) {
    if (!_container)
        return;
    _container.innerHTML =
        _styleBlock() +
            '<div class="mml-sv-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.18);">' +
            '<div class="mml-sv-shell">' +
            '<div class="mml-sv-head">' +
            '<div class="mml-sv-title">Sort View</div>' +
            '<div class="mml-sv-spacer"></div>' +
            '<div class="mml-sv-hint">Esc to dismiss</div>' +
            '</div>' +
            '<div class="mml-sv-empty">' + _escape(reason) + '</div>' +
            '</div>' +
            '</div>';
    _wireBackdrop();
}
function _renderReady() {
    if (!_container)
        return;
    const sorted = _sortRows(_rows);
    // Build header HTML with sort indicators.
    const headerCells = [
        ['sender', 'mml-sv-th'],
        ['rating', 'mml-sv-th mml-sv-rate'],
        ['llm_rate', 'mml-sv-th mml-sv-llm'],
        ['date', 'mml-sv-th mml-sv-date'],
        ['count', 'mml-sv-th mml-sv-cnt'],
        ['engagement', 'mml-sv-th mml-sv-eng'],
        ['to_addr', 'mml-sv-th'],
        ['subject', 'mml-sv-th'],
    ];
    let headerHTML = '';
    for (const [key, cls] of headerCells) {
        const col = SORT_COLUMNS[key];
        const active = key === _sortKey ? ' active' : '';
        const arrow = key === _sortKey ? (_sortDir === 'desc' ? ' ↓' : ' ↑') : '';
        headerHTML +=
            '<div class="' + cls + active + '" data-sort-key="' + key + '">' +
                _escape(col.label) + arrow + '</div>';
    }
    // Body rows. When sorted by sender, show the sender name only on the
    // FIRST row of each group; subsequent rows in the group show a muted
    // pseudo-blank so the visual grouping is obvious.
    let bodyHTML = '';
    let lastSenderKey = null;
    for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i];
        const e = r.enriched;
        const isGroupHead = (_sortKey !== 'sender') || (r.senderGroupKey !== lastSenderKey);
        if (_sortKey === 'sender')
            lastSenderKey = r.senderGroupKey;
        const senderText = isGroupHead
            ? _escape(_displaySender(e))
            : '<span style="color:#bbb">↳</span>';
        const senderClass = isGroupHead ? 'mml-sv-sender' : 'mml-sv-sender muted';
        const cntText = isGroupHead && r.senderGroupSize > 1 ? '×' + r.senderGroupSize : '';
        const engText = e.sender_send_count > 0 ? String(e.sender_send_count) : '';
        const toAddr = _shortAddr(e.to_me_addr || '');
        const subj = _escape(e.subject || '(no subject)');
        const dateStr = _shortDate(e.received_date);
        const ownedRating = _markOwnedRating(e);
        let rateHTML = '';
        if (ownedRating != null) {
            rateHTML = '<span class="mml-sv-rate-pill">' + ownedRating + '</span>';
        }
        let llmHTML = '';
        if (e.suggested_rating != null && e.suggested_rating > 0) {
            llmHTML = '<span class="mml-sv-llm-pill">' + e.suggested_rating + '</span>';
        }
        bodyHTML +=
            '<div class="mml-sv-row" data-row-idx="' + i + '">' +
                '<div class="' + senderClass + '">' + senderText + '</div>' +
                '<div class="mml-sv-rate">' + rateHTML + '</div>' +
                '<div class="mml-sv-llm">' + llmHTML + '</div>' +
                '<div class="mml-sv-date">' + _escape(dateStr) + '</div>' +
                '<div class="mml-sv-cnt">' + _escape(cntText) + '</div>' +
                '<div class="mml-sv-eng">' + _escape(engText) + '</div>' +
                '<div class="mml-sv-cell">' + _escape(toAddr) + '</div>' +
                '<div class="mml-sv-cell">' + subj + '</div>' +
                '</div>';
    }
    _container.innerHTML =
        _styleBlock() +
            '<div class="mml-sv-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.18);">' +
            '<div class="mml-sv-shell">' +
            '<div class="mml-sv-head">' +
            '<div class="mml-sv-title">Sort View</div>' +
            '<div class="mml-sv-meta">' + sorted.length + ' threads · sorted by ' +
            _escape(SORT_COLUMNS[_sortKey].label) + ' ' + _escape(_sortDir) + '</div>' +
            '<div class="mml-sv-spacer"></div>' +
            '<div class="mml-sv-hint">Click row to open · header to sort · Esc to dismiss</div>' +
            '</div>' +
            '<div class="mml-sv-thead">' + headerHTML + '</div>' +
            '<div class="mml-sv-body">' + bodyHTML + '</div>' +
            '</div>' +
            '</div>';
    _wireBackdrop();
    _wireRows(sorted);
    _wireHeaders();
}
function _wireBackdrop() {
    if (!_container)
        return;
    const backdrop = _container.querySelector('.mml-sv-backdrop');
    if (backdrop)
        backdrop.addEventListener('click', function (e) {
            if (e.target === backdrop)
                _dismiss();
        });
}
// Scroll Mailspring's thread list so the clicked thread is centered.
//
// We can't use ThreadListStore.dataSource() — that store is not actually
// exported via mailspring-exports, so the destructure yields undefined.
// Instead we rely on the fact that the threads array passed in by the
// handler (Layer B: perspective.threads() bounded by MAX_THREADS) is in
// the same order the rendered thread list uses, so `_threadIndexById`
// gives us the same offset Mailspring's data source would.
//
// The DOM viewport (.scroll-region-content) has a scroll event listener
// that drives Mailspring's own range/retain logic — setting scrollTop
// directly causes Mailspring to refetch and mount the rows we land near,
// without us needing access to the dataSource at all. Every rendered row
// has id="list-item-<thread.id>" (multiselect-list.js:194), constant
// across split/list layouts.
function _scrollThreadListToFocused(thread) {
    if (!thread || !thread.id)
        return;
    const rowId = 'list-item-' + thread.id;
    const list = document.querySelector('.thread-list');
    if (!list) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] sort-view: .thread-list not found, cannot scroll');
        return;
    }
    const viewport = list.querySelector('.scroll-region-content');
    if (!viewport) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] sort-view: .scroll-region-content not found inside .thread-list');
        return;
    }
    const idx = _threadIndexById.has(thread.id) ? _threadIndexById.get(thread.id) : -1;
    if (idx < 0) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] sort-view: thread ' + thread.id + ' not in perspective index (was it added after overlay opened?)');
        return;
    }
    // Coarse scroll: set viewport.scrollTop so the target index lands in the
    // center. Mailspring's scroll listener will then refetch/mount that range.
    const sample = list.querySelector('.list-tabular-item');
    const itemHeight = (sample && sample.offsetHeight) || 70;
    const viewportHeight = viewport.clientHeight;
    const targetTop = idx * itemHeight;
    viewport.scrollTop = Math.max(0, targetTop - (viewportHeight / 2) + (itemHeight / 2));
    // Poll for the row to mount, then refine with scrollIntoView.
    const startTime = Date.now();
    const maxWaitMs = 1500;
    const refine = function () {
        const row = document.getElementById(rowId);
        if (row && typeof row.scrollIntoView === 'function') {
            try {
                row.scrollIntoView({ block: 'center', behavior: 'auto' });
            }
            catch (_) { /* noop */ }
            // eslint-disable-next-line no-console
            console.info('[mml-productivity] sort-view: scrolled to ' + rowId + ' (idx=' + idx + ')');
            return;
        }
        if (Date.now() - startTime > maxWaitMs) {
            // eslint-disable-next-line no-console
            console.warn('[mml-productivity] sort-view: row ' + rowId + ' never mounted after coarse scroll (idx=' + idx + ', coarse scrollTop=' + viewport.scrollTop + ')');
            return;
        }
        requestAnimationFrame(refine);
    };
    requestAnimationFrame(refine);
}
function _wireRows(sortedRows) {
    if (!_container)
        return;
    _container.querySelectorAll('.mml-sv-row').forEach(function (el) {
        el.addEventListener('click', function () {
            const idx = parseInt(el.getAttribute('data-row-idx'), 10);
            const row = sortedRows[idx];
            if (!row || !row.thread) {
                _dismiss();
                return;
            }
            try {
                Actions.setFocus({ collection: 'thread', item: row.thread });
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[mml-productivity] sort-view setFocus threw:', err);
            }
            _scrollThreadListToFocused(row.thread);
            _dismiss();
        });
    });
}
function _wireHeaders() {
    if (!_container)
        return;
    _container.querySelectorAll('.mml-sv-th').forEach(function (el) {
        el.addEventListener('click', function () {
            const key = el.getAttribute('data-sort-key');
            if (!key)
                return;
            if (key === _sortKey) {
                _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
            }
            else {
                _sortKey = key;
                _sortDir = SORT_COLUMNS[key].defaultDir || 'asc';
            }
            _renderReady();
        });
    });
}
function _onDocKeydown(e) {
    if (_state === 'idle')
        return;
    if ((e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        _dismiss();
    }
}
// -------------------------------------------------------------------------
// Public API
/**
 * Open the sort-view overlay.
 *
 *   threads            — Array<MailspringThread> from ThreadListStore.dataSource()
 *   rfcByThread        — Map<thread.id, rfcMessageId>
 *   enriched           — list of EnrichedThread objects from /threads-enrich,
 *                        same order as threads (matched on rfc_message_id).
 */
function openSortView({ threads, rfcByThread, enriched }) {
    _dismiss();
    if (!Array.isArray(threads) || threads.length === 0) {
        _ensureContainer();
        _container.style.display = '';
        _state = 'ready';
        _renderEmpty('No threads in current perspective.');
        _docKeyHandler = _onDocKeydown;
        document.addEventListener('keydown', _docKeyHandler, true);
        return;
    }
    _ensureContainer();
    _container.style.display = '';
    _docKeyHandler = _onDocKeydown;
    document.addEventListener('keydown', _docKeyHandler, true);
    // Threads keyed by rfc for the enriched-rows mapping.
    const threadsByRfc = new Map();
    for (const t of threads) {
        const rfc = rfcByThread.get(t.id);
        if (rfc)
            threadsByRfc.set(rfc, t);
    }
    // Build perspective-order index for scroll-on-click. threads[] comes back
    // from perspective.threads() in the same order Mailspring uses to render
    // the inbox, so the array index equals the row offset in the rendered list.
    _threadIndexById = new Map();
    for (let i = 0; i < threads.length; i++) {
        const t = threads[i];
        if (t && t.id)
            _threadIndexById.set(t.id, i);
    }
    _rows = _computeRows(enriched || [], threadsByRfc);
    if (_rows.length === 0) {
        _state = 'ready';
        _renderEmpty('Could not enrich any of the visible threads — sidecar offline or unknown messages.');
        return;
    }
    _sortKey = 'rating';
    _sortDir = 'desc';
    _state = 'ready';
    _renderReady();
}
function showLoading(threadCount) {
    _ensureContainer();
    _container.style.display = '';
    _state = 'loading';
    _docKeyHandler = _onDocKeydown;
    document.addEventListener('keydown', _docKeyHandler, true);
    _renderLoading(threadCount);
}
function showError(reason) {
    _ensureContainer();
    _container.style.display = '';
    _state = 'ready';
    _docKeyHandler = _onDocKeydown;
    document.addEventListener('keydown', _docKeyHandler, true);
    _renderEmpty(reason || 'Failed to load.');
}
function close() {
    _dismiss();
}
module.exports = { openSortView, showLoading, showError, close };
module.exports.openSortView = openSortView;
module.exports.showLoading = showLoading;
module.exports.showError = showError;
module.exports.close = close;
module.exports.default = { openSortView, showLoading, showError, close };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29ydC12aWV3LW92ZXJsYXkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvc29ydC12aWV3LW92ZXJsYXkuanN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHdCQUF3QjtBQUN4QixFQUFFO0FBQ0YseUVBQXlFO0FBQ3pFLHNEQUFzRDtBQUN0RCx3RUFBd0U7QUFDeEUsbUVBQW1FO0FBQ25FLEVBQUU7QUFDRixRQUFRO0FBQ1IsNEVBQTRFO0FBQzVFLDJFQUEyRTtBQUMzRSxvRUFBb0U7QUFDcEUsdUVBQXVFO0FBQ3ZFLDBFQUEwRTtBQUMxRSw0RUFBNEU7QUFDNUUsMERBQTBEO0FBQzFELHlEQUF5RDtBQUV6RCw0RUFBNEU7QUFDNUUsNEVBQTRFO0FBQzVFLDZFQUE2RTtBQUM3RSxrRUFBa0U7QUFDbEUsTUFBTSxFQUFFLE9BQU8sRUFBRSxHQUFHLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0FBRWxELElBQUksVUFBVSxHQUFHLElBQUksQ0FBQztBQUN0QixJQUFJLE1BQU0sR0FBRyxNQUFNLENBQUMsQ0FBRywrQkFBK0I7QUFDdEQsSUFBSSxLQUFLLEdBQUcsRUFBRSxDQUFDLENBQVEsMERBQTBEO0FBQ2pGLElBQUksZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLEVBQUUsQ0FBQyxDQUFDLDJDQUEyQztBQUM3RSxJQUFJLFFBQVEsR0FBRyxRQUFRLENBQUM7QUFDeEIsSUFBSSxRQUFRLEdBQUcsTUFBTSxDQUFDO0FBQ3RCLElBQUksY0FBYyxHQUFHLElBQUksQ0FBQztBQUUxQiw0RUFBNEU7QUFDNUUsbUJBQW1CO0FBRW5CLDREQUE0RDtBQUM1RCx3RUFBd0U7QUFDeEUsaUVBQWlFO0FBQ2pFLEVBQUU7QUFDRixxRUFBcUU7QUFDckUsb0VBQW9FO0FBQ3BFLG9FQUFvRTtBQUNwRSxvRUFBb0U7QUFDcEUsc0RBQXNEO0FBQ3RELEVBQUU7QUFDRix3RUFBd0U7QUFDeEUseUNBQXlDO0FBQ3pDLE1BQU0seUJBQXlCLEdBQUcsQ0FB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