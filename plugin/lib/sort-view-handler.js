"use strict";
// sort-view-handler.js
//
// Cmd+Option+V → opens the sort-view overlay populated with the threads
// currently rendered in Mailspring's ThreadListStore dataSource (i.e. the
// active perspective: Inbox, a Routed/* folder, search results, etc).
Object.defineProperty(exports, "__esModule", { value: true });
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
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] sort-view: ThreadListStore.dataSource() threw:', err);
        return [];
    }
    if (!ds)
        return [];
    const total = (typeof ds.count === 'function') ? ds.count() : 0;
    const cap = Math.min(total, MAX_THREADS);
    const out = [];
    for (let i = 0; i < cap; i++) {
        let t = null;
        try {
            t = ds.get(i);
        }
        catch (_) {
            t = null;
        }
        if (t && t.id)
            out.push(t);
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
    }
    catch (err) {
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
    }
    catch (err) {
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
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] sort-view: failed to clone/limit inner query:', err);
        return Promise.resolve({ kind: 'no-query' });
    }
    const queryPromise = bounded.then((results) => {
        const arr = Array.isArray(results) ? results : [];
        return { kind: 'ok', threads: arr.filter((t) => t && t.id) };
    }, (err) => {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] sort-view: bounded perspective query rejected:', err);
        return { kind: 'error' };
    });
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
    if (result.kind === 'no-perspective')
        failureReason = 'no-perspective';
    else if (result.kind === 'no-query')
        failureReason = 'no-query';
    else if (result.kind === 'timeout')
        failureReason = 'timeout';
    else if (result.kind === 'error')
        failureReason = 'query-error';
    else if (result.kind === 'ok')
        failureReason = 'perspective-empty';
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
        try {
            ids = await sidecarClient.rfcIdsForThread(t);
        }
        catch (_) {
            ids = [];
        }
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
    }
    catch (err) {
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
function registerSortViewCommand() {
    try {
        _disposable = AppEnv.commands.add(document.body, 'mml-productivity:open-sort-view', () => {
            // eslint-disable-next-line no-console
            console.info('[mml-productivity] open-sort-view command fired');
            openSortView();
        });
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] sort-view ready (Cmd+Option+V)');
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] failed to register sort-view command:', err);
    }
}
exports.registerSortViewCommand = registerSortViewCommand;
function unregisterSortViewCommand() {
    if (_disposable && _disposable.dispose) {
        try {
            _disposable.dispose();
        }
        catch (_) { /* noop */ }
    }
    _disposable = null;
}
exports.unregisterSortViewCommand = unregisterSortViewCommand;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29ydC12aWV3LWhhbmRsZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvc29ydC12aWV3LWhhbmRsZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLHVCQUF1QjtBQUN2QixFQUFFO0FBQ0Ysd0VBQXdFO0FBQ3hFLDBFQUEwRTtBQUMxRSxzRUFBc0U7O0FBRXRFLE1BQU0sRUFBRSxlQUFlLEVBQUUsdUJBQXVCLEVBQUUsR0FBRyxPQUFPLENBQUMsb0JBQW9CLENBQUMsQ0FBQztBQUVuRixNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsa0JBQWtCLENBQUMsQ0FBQztBQUNsRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMscUJBQXFCLENBQUMsQ0FBQztBQUV2RCwyRUFBMkU7QUFDM0Usc0VBQXNFO0FBQ3RFLGtCQUFrQjtBQUNsQixNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUM7QUFFeEIsMEVBQTBFO0FBQzFFLDRFQUE0RTtBQUM1RSxnREFBZ0Q7QUFDaEQsU0FBUyxzQkFBc0I7SUFDN0IsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDO0lBQ2QsSUFBSTtRQUNGLEVBQUUsR0FBRyxlQUFlLElBQUksZUFBZSxDQUFDLFVBQVUsSUFBSSxlQUFlLENBQUMsVUFBVSxFQUFFLENBQUM7S0FDcEY7SUFBQyxPQUFPLEdBQUcsRUFBRTtRQUNaLHNDQUFzQztRQUN0QyxPQUFPLENBQUMsSUFBSSxDQUFDLG1FQUFtRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ3ZGLE9BQU8sRUFBRSxDQUFDO0tBQ1g7SUFDRCxJQUFJLENBQUMsRUFBRTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ25CLE1BQU0sS0FBSyxHQUFHLENBQUMsT0FBTyxFQUFFLENBQUMsS0FBSyxLQUFLLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNoRSxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMs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