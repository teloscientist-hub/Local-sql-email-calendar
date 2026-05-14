// sort-view-handler.js
//
// Cmd+Option+V → opens the sort-view overlay populated with the threads
// currently rendered in Mailspring's ThreadListStore dataSource (i.e. the
// active perspective: Inbox, a Routed/* folder, search results, etc).

const { ThreadListStore, FocusedPerspectiveStore } = require('mailspring-exports');

const sidecarClient = require('./sidecar-client');
const sortViewOverlay = require('./sort-view-overlay');

// Soft cap so we don't blast the sidecar with thousands of ids if the user
// has a perspective with a huge backlog. Most triage perspectives are
// well under 200.
const MAX_THREADS = 500;

// Layer A: the rendered thread-list dataSource. Fast path. Empty when the
// thread-list column isn't currently rendering (thread focused, perspective
// mid-load, layout without a thread list, etc).
function _collectFromDataSource() {
  let ds = null;
  try {
    ds = ThreadListStore && ThreadListStore.dataSource && ThreadListStore.dataSource();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] sort-view: ThreadListStore.dataSource() threw:', err);
    return [];
  }
  if (!ds) return [];
  const total = (typeof ds.count === 'function') ? ds.count() : 0;
  const cap = Math.min(total, MAX_THREADS);
  const out = [];
  for (let i = 0; i < cap; i++) {
    let t = null;
    try { t = ds.get(i); } catch (_) { t = null; }
    if (t && t.id) out.push(t);
  }
  return out;
}

function _waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Layer B: pull threads from the currently focused MailboxPerspective.
//
// `perspective.threads()` actually returns a MutableQuerySubscription (or
// null for Drafts), NOT a ModelQuery — subscriptions have addCallback, not
// .then. The subscription wraps a real ModelQuery at `._query` that we can
// clone, give a real limit, and resolve with `.then()` (ModelQuery.then
// calls .run()). The clone avoids mutating the live subscription's range.
//
// Returns a tagged object:
//   { kind: 'no-perspective' }   — null current, or threads() returned null
//   { kind: 'no-query' }         — subscription had no usable _query
//   { kind: 'timeout' }          — query did not resolve within budget
//   { kind: 'error' }            — query rejected
//   { kind: 'ok', threads: [] } — success (threads may be empty)
const _LAYER_B_TIMEOUT_MS = 3000;

function _collectFromActivePerspective() {
  let persp = null;
  try {
    persp = FocusedPerspectiveStore && FocusedPerspectiveStore.current && FocusedPerspectiveStore.current();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] sort-view: FocusedPerspectiveStore.current() threw:', err);
    return Promise.resolve({ kind: 'no-perspective' });
  }
  if (!persp || typeof persp.threads !== 'function') {
    return Promise.resolve({ kind: 'no-perspective' });
  }
  let sub = null;
  try {
    sub = persp.threads();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] sort-view: perspective.threads() threw:', err);
    return Promise.resolve({ kind: 'no-perspective' });
  }
  if (!sub) {
    // DraftsMailboxPerspective.threads() returns null.
    return Promise.resolve({ kind: 'no-perspective' });
  }

  // Reach into the subscription's underlying ModelQuery. Brittle (private
  // field) but the alternative is duplicating the per-subclass query-build
  // logic from mailbox-perspective.js for every perspective type.
  const innerQuery = sub._query;
  if (!innerQuery || typeof innerQuery.clone !== 'function' || typeof innerQuery.then !== 'function') {
    return Promise.resolve({ kind: 'no-query' });
  }

  // Clone so we don't disturb the live subscription's range. The subscription
  // typically holds .limit(0) (renderer overrides via replaceRange). We need
  // a real, bounded limit so .run() returns Thread[].
  let bounded = null;
  try {
    bounded = innerQuery.clone().offset(0).limit(MAX_THREADS);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] sort-view: failed to clone/limit inner query:', err);
    return Promise.resolve({ kind: 'no-query' });
  }

  const queryPromise = bounded.then(
    (results) => {
      const arr = Array.isArray(results) ? results : [];
      return { kind: 'ok', threads: arr.filter((t) => t && t.id) };
    },
    (err) => {
      // eslint-disable-next-line no-console
      console.warn('[mml-productivity] sort-view: bounded perspective query rejected:', err);
      return { kind: 'error' };
    },
  );
  const timeoutPromise = _waitMs(_LAYER_B_TIMEOUT_MS).then(() => ({ kind: 'timeout' }));
  return Promise.race([queryPromise, timeoutPromise]);
}

// Orchestrator: Layer A → B → C. Returns { threads, failureReason }.
async function _collectThreadsForActivePerspective() {
  // Layer A — fast path.
  let threads = _collectFromDataSource();
  if (threads.length > 0) {
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] sort-view: Layer A (dataSource) used, ' + threads.length + ' threads');
    return { threads, failureReason: null };
  }

  // Layer B — focused perspective query.
  const result = await _collectFromActivePerspective();
  if (result.kind === 'ok' && result.threads.length > 0) {
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] sort-view: Layer B (perspective query) used, ' + result.threads.length + ' threads');
    return { threads: result.threads, failureReason: null };
  }

  // Layer B did not deliver. Layer C — short re-poll of dataSource in case
  // the perspective is mid-load.
  await _waitMs(250);
  threads = _collectFromDataSource();
  if (threads.length > 0) {
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] sort-view: Layer C (re-poll 250ms) used, ' + threads.length + ' threads');
    return { threads, failureReason: null };
  }
  await _waitMs(500);
  threads = _collectFromDataSource();
  if (threads.length > 0) {
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] sort-view: Layer C (re-poll 750ms) used, ' + threads.length + ' threads');
    return { threads, failureReason: null };
  }

  // Map Layer B's specific outcome to a user-facing reason.
  // eslint-disable-next-line no-console
  console.warn('[mml-productivity] sort-view: all layers empty; Layer B kind=' + result.kind);
  let failureReason = 'datasource-still-empty';
  if (result.kind === 'no-perspective') failureReason = 'no-perspective';
  else if (result.kind === 'no-query') failureReason = 'no-query';
  else if (result.kind === 'timeout') failureReason = 'timeout';
  else if (result.kind === 'error') failureReason = 'query-error';
  else if (result.kind === 'ok') failureReason = 'perspective-empty';
  return { threads: [], failureReason };
}

const _FAILURE_MESSAGES = {
  'no-perspective': 'No active perspective focused.',
  'no-query': 'Active perspective has no underlying query (subscription type unsupported).',
  'timeout': 'Perspective query did not finish in time. Try again.',
  'query-error': 'Perspective query failed. See DevTools console.',
  'perspective-empty': 'Active perspective returned no threads.',
  'datasource-still-empty': 'Thread list did not load in time. Try again.',
};

async function openSortView() {
  // Show loading immediately for responsiveness — collection can take up
  // to ~2.25s in the worst case (Layer B 1.5s timeout + Layer C 0.75s).
  sortViewOverlay.showLoading(0);

  const { threads, failureReason } = await _collectThreadsForActivePerspective();
  if (failureReason) {
    sortViewOverlay.showError(_FAILURE_MESSAGES[failureReason] || 'No threads to sort.');
    return;
  }

  // Update loading state now that we know the count.
  sortViewOverlay.showLoading(threads.length);

  // Resolve RFC-822 ids for each thread. Use the sidecar-client helper
  // which prefers the fast in-memory path (thread.lastMessage.headerMessageId).
  const rfcByThread = new Map();
  const rfcIds = [];
  for (const t of threads) {
    let ids = [];
    try { ids = await sidecarClient.rfcIdsForThread(t); } catch (_) { ids = []; }
    if (ids && ids.length > 0) {
      // Use the latest message in the thread as the representative row.
      const last = ids[ids.length - 1];
      rfcByThread.set(t.id, last);
      rfcIds.push(last);
    }
  }
  if (rfcIds.length === 0) {
    sortViewOverlay.showError('Could not resolve any RFC-822 ids for the visible threads.');
    return;
  }

  // Bulk enrich via the sidecar.
  let resp = null;
  try {
    resp = await sidecarClient.threadsEnrich(rfcIds);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] sort-view: /threads-enrich threw:', err);
    resp = null;
  }
  if (!resp) {
    sortViewOverlay.showError('Sidecar offline or unreachable.');
    return;
  }
  if (resp.error) {
    sortViewOverlay.showError('Sidecar error: ' + resp.error);
    return;
  }
  const enriched = Array.isArray(resp.threads) ? resp.threads : [];
  if (enriched.length === 0) {
    sortViewOverlay.showError('Sidecar returned no enrichment rows.');
    return;
  }

  sortViewOverlay.openSortView({ threads, rfcByThread, enriched });
}

let _disposable = null;

export function registerSortViewCommand() {
  try {
    _disposable = AppEnv.commands.add(
      document.body,
      'mml-productivity:open-sort-view',
      () => {
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] open-sort-view command fired');
        openSortView();
      },
    );
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] sort-view ready (Cmd+Option+V)');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] failed to register sort-view command:', err);
  }
}

export function unregisterSortViewCommand() {
  if (_disposable && _disposable.dispose) {
    try { _disposable.dispose(); } catch (_) { /* noop */ }
  }
  _disposable = null;
}
