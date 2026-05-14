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
let _state = 'idle';   // 'idle' | 'loading' | 'ready'
let _rows = [];        // [{ thread, enriched, senderGroupKey, senderGroupSize }]
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
  if (!e || e.rating == null) return null;
  const src = (e.rating_source || '').toLowerCase();
  if (MARK_OWNED_RATING_SOURCES.indexOf(src) === -1) return null;
  if (e.rating <= 0) return null;
  return e.rating;
}

const SORT_COLUMNS = {
  sender:     { label: 'Sender',     key: (r) => _displaySender(r.enriched).toLowerCase() },
  count:      { label: 'Cnt',        key: (r) => r.senderGroupSize, defaultDir: 'desc' },
  engagement: { label: 'Engagement', key: (r) => (r.enriched.sender_send_count || 0), defaultDir: 'desc' },
  to_addr:    { label: 'Sent to',    key: (r) => (r.enriched.to_me_addr || '').toLowerCase() },
  subject:    { label: 'Subject',    key: (r) => (r.enriched.subject || '').toLowerCase() },
  date:       { label: 'Date',       key: (r) => (r.enriched.received_date || ''), defaultDir: 'desc' },
  rating:     { label: 'Rate',       key: (r) => { const v = _markOwnedRating(r.enriched); return v == null ? -1 : v; }, defaultDir: 'desc' },
  llm_rate:   { label: 'LLM Rate',   key: (r) => (r.enriched.suggested_rating == null ? -1 : r.enriched.suggested_rating), defaultDir: 'desc' },
};

function _displaySender(e) {
  if (!e) return '(unknown)';
  const name = (e.sender_name || '').trim();
  if (name) return name;
  return (e.sender_addr || '(unknown)').trim();
}

function _escape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _shortDate(iso) {
  if (!iso) return '';
  // received_date format: "2026-05-11T18:58:27+00:00" or similar
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const now = new Date();
  const ms = now - d;
  const day = 24 * 60 * 60 * 1000;
  if (ms < 0) return d.toISOString().slice(0, 10);
  if (ms < day) {
    const h = Math.floor(ms / (60 * 60 * 1000));
    if (h === 0) return 'now';
    return h + 'h';
  }
  const days = Math.floor(ms / day);
  if (days < 30) return days + 'd';
  if (days < 365) return Math.floor(days / 7) + 'w';
  return Math.floor(days / 365) + 'y';
}

function _shortAddr(addr) {
  if (!addr) return '';
  const a = String(addr);
  if (a.length <= 22) return a;
  return a.slice(0, 20) + '…';
}

// -------------------------------------------------------------------------
// Container

function _ensureContainer() {
  if (_container) return _container;
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
    if (!t) continue;
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
    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    // Secondary: by date descending within ties so newest float to top.
    const ad = tiebreakDate(a);
    const bd = tiebreakDate(b);
    if (ad < bd) return  1;
    if (ad > bd) return -1;
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
    if (/\btheme-ui-dark\b|\btheme-ui-darkside\b/.test(cls)) return true;
    if (/\btheme-ui-light\b/.test(cls)) return false;
  } catch (_) { /* noop */ }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
  } catch (_) { /* noop */ }
  return false;
}

function _styleBlock() {
  const dark = _isDarkTheme();
  const c = dark ? {
    shellBg:     '#1f2126',
    shellShadow: '0 12px 48px rgba(0,0,0,0.6)',
    border:      '#33363d',
    rowBorder:   '#2a2c32',
    headBg:      '#26282e',
    title:       '#e6e6e6',
    meta:        '#8a8f99',
    hint:        '#8a8f99',
    thColor:     '#9aa0aa',
    thHover:     '#f0f0f0',
    thActive:    '#5aa0e6',
    sender:      '#e6e6e6',
    senderMuted: '#5a5e66',
    cell:        '#c4c8d0',
    numMuted:    '#8a8f99',
    date:        '#8a8f99',
    rowHover:    '#2a323e',
    pillText:    '#fff',
    pillBg:      '#4a4e57',
    backdrop:    'rgba(0,0,0,0.55)',
    emptyText:   '#8a8f99',
  } : {
    shellBg:     '#ffffff',
    shellShadow: '0 12px 48px rgba(0,0,0,0.32)',
    border:      '#e8e8e8',
    rowBorder:   '#f0f0f0',
    headBg:      '#f5f5f5',
    title:       '#222222',
    meta:        '#888888',
    hint:        '#888888',
    thColor:     '#666666',
    thHover:     '#222222',
    thActive:    '#1d6fbf',
    sender:      '#222222',
    senderMuted: '#aaaaaa',
    cell:        '#444444',
    numMuted:    '#666666',
    date:        '#888888',
    rowHover:    '#f3f8fd',
    pillText:    '#ffffff',
    pillBg:      '#888888',
    backdrop:    'rgba(0,0,0,0.18)',
    emptyText:   '#888888',
  };
  return (
    '<style>' +
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
    '</style>'
  );
}

function _renderLoading(threadCount) {
  if (!_container) return;
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
  if (!_container) return;
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
  if (!_container) return;
  const sorted = _sortRows(_rows);

  // Build header HTML with sort indicators.
  const headerCells = [
    ['sender',     'mml-sv-th'],
    ['rating',     'mml-sv-th mml-sv-rate'],
    ['llm_rate',   'mml-sv-th mml-sv-llm'],
    ['date',       'mml-sv-th mml-sv-date'],
    ['count',      'mml-sv-th mml-sv-cnt'],
    ['engagement', 'mml-sv-th mml-sv-eng'],
    ['to_addr',    'mml-sv-th'],
    ['subject',    'mml-sv-th'],
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
    if (_sortKey === 'sender') lastSenderKey = r.senderGroupKey;
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
  if (!_container) return;
  const backdrop = _container.querySelector('.mml-sv-backdrop');
  if (backdrop) backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) _dismiss();
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
  if (!thread || !thread.id) return;
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
      try { row.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (_) { /* noop */ }
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
  if (!_container) return;
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
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] sort-view setFocus threw:', err);
      }
      _scrollThreadListToFocused(row.thread);
      _dismiss();
    });
  });
}

function _wireHeaders() {
  if (!_container) return;
  _container.querySelectorAll('.mml-sv-th').forEach(function (el) {
    el.addEventListener('click', function () {
      const key = el.getAttribute('data-sort-key');
      if (!key) return;
      if (key === _sortKey) {
        _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortKey = key;
        _sortDir = SORT_COLUMNS[key].defaultDir || 'asc';
      }
      _renderReady();
    });
  });
}

function _onDocKeydown(e) {
  if (_state === 'idle') return;
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
    if (rfc) threadsByRfc.set(rfc, t);
  }

  // Build perspective-order index for scroll-on-click. threads[] comes back
  // from perspective.threads() in the same order Mailspring uses to render
  // the inbox, so the array index equals the row offset in the rendered list.
  _threadIndexById = new Map();
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    if (t && t.id) _threadIndexById.set(t.id, i);
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
