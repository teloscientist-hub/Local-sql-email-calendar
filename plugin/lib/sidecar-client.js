// sidecar-client.js
//
// Phase 3 — typed wrapper around the mml-classifier HTTP sidecar.
//
//   GET  /thread?ids=<rfc-id>,<rfc-id>...   → ThreadState
//   POST /rate-message {rfc_message_id, rating, note, what_i_saw_on_screen,
//                       plugin_version}      → record manual tag
//   POST /add-note     {rfc_message_id, note} → set note on latest rating row
//   GET  /healthz                            → service status
//
// Design notes:
//   * 200ms hard fetch timeout via AbortController. On timeout/error the
//     getThread call returns null so the badge silent-fails (no badge for
//     that row, no console spam beyond a one-time warning per-session).
//   * In-memory ThreadState cache keyed by sorted RFC-822 ID set, TTL 30s.
//     Re-renders of the same row reuse the cached state. After a successful
//     rateMessage/addNote the relevant cache entries are busted.
//   * Resolves a Mailspring Thread → array of headerMessageIds via
//     DatabaseStore so the badge can look up by RFC-822 ID. Mailspring
//     does NOT pre-load thread.messages; it's a deferred query.
const { DatabaseStore, Message } = require('mailspring-exports');
// ---------------------------------------------------------------------------
// Configuration
const SIDECAR_BASE_URL = 'http://127.0.0.1:8765';
const FETCH_TIMEOUT_MS = 1000;
const THREAD_CACHE_TTL_MS = 30 * 1000;
// Mailspring Thread → headerMessageId list cache.
// Keyed by Mailspring's thread.id; value is { ids, expiresAt }.
const _threadIdsCache = new Map();
const THREAD_IDS_TTL_MS = 60 * 1000;
// ThreadState cache. Keyed by the sorted RFC-822 ID join.
// Value: { state, expiresAt }.
const _threadStateCache = new Map();
let _warnedSidecarDown = false;
// ---------------------------------------------------------------------------
// Thread → RFC-822 IDs resolution
//
// Mailspring 1.21 doesn't preload Message rows for closed inbox threads,
// so DatabaseStore.findAll(Message).where({threadId}) returns [] there.
// We try synchronous shortcuts first (thread.lastMessage / thread.messages /
// any per-thread denormalized headerMessageId) and only fall through to
// the DB query when those don't yield ids — that path still works for
// thread-detail views where messages ARE loaded.
let _warnedEmptyIds = false;
function _idsFromInMemoryThread(thread) {
    if (!thread)
        return [];
    const ids = [];
    // a) thread.lastMessage — property OR method on different Mailspring builds.
    try {
        let lm = thread.lastMessage;
        if (typeof lm === 'function')
            lm = lm.call(thread);
        if (lm && lm.headerMessageId)
            ids.push(lm.headerMessageId);
    }
    catch (_) { /* shape-defensive */ }
    // b) thread.messages — array of cached Message instances on some builds.
    try {
        const msgs = thread.messages;
        if (Array.isArray(msgs)) {
            for (const m of msgs) {
                if (m && m.headerMessageId)
                    ids.push(m.headerMessageId);
            }
        }
    }
    catch (_) { /* shape-defensive */ }
    // c) thread.headerMessageId — denormalized most-recent message id, seen
    //    on some Mailspring versions for thread-list rendering.
    try {
        if (typeof thread.headerMessageId === 'string' && thread.headerMessageId) {
            ids.push(thread.headerMessageId);
        }
    }
    catch (_) { /* shape-defensive */ }
    return Array.from(new Set(ids.filter(Boolean)));
}
async function rfcIdsForThread(thread) {
    if (!thread || !thread.id)
        return [];
    const cached = _threadIdsCache.get(thread.id);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.ids;
    }
    // Fast path: in-memory shortcuts on the Thread model.
    const fast = _idsFromInMemoryThread(thread);
    if (fast.length > 0) {
        _threadIdsCache.set(thread.id, {
            ids: fast,
            expiresAt: Date.now() + THREAD_IDS_TTL_MS,
        });
        return fast;
    }
    // Fallback: DB query (works for opened threads where messages are loaded).
    try {
        const messages = await DatabaseStore
            .findAll(Message)
            .where({ threadId: thread.id });
        const ids = (messages || [])
            .map(m => m && m.headerMessageId)
            .filter(Boolean);
        if (ids.length === 0 && !_warnedEmptyIds) {
            _warnedEmptyIds = true;
            // eslint-disable-next-line no-console
            console.warn('[mml-productivity] rfcIdsForThread: no ids for thread', thread.id, '— inspected keys:', Object.keys(thread).slice(0, 20), 'lastMessage type:', typeof thread.lastMessage, 'messages type:', typeof thread.messages);
        }
        _threadIdsCache.set(thread.id, {
            ids,
            expiresAt: Date.now() + THREAD_IDS_TTL_MS,
        });
        return ids;
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] rfcIdsForThread failed for', thread.id, err);
        return [];
    }
}
// ---------------------------------------------------------------------------
// fetch with timeout
async function _fetch(method, path, body, opts) {
    const timeoutMs = (opts && Number.isFinite(opts.timeout)) ? opts.timeout : FETCH_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${SIDECAR_BASE_URL}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
        if (!res.ok) {
            // Sidecar's contract is "always 200" — non-200 means transport failure.
            return null;
        }
        return await res.json();
    }
    catch (err) {
        if (!_warnedSidecarDown) {
            _warnedSidecarDown = true;
            // eslint-disable-next-line no-console
            console.warn(`[mml-productivity] sidecar unreachable (first warning only): ${err.message}`);
        }
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
function _resetSidecarWarning() {
    _warnedSidecarDown = false;
}
// ---------------------------------------------------------------------------
// /thread
/**
 * Fetch ThreadState for an array of RFC-822 IDs. Returns null on
 * sidecar-down / timeout (badge silent-fails). Otherwise an object:
 *   { rating, rating_source, cluster_id, cluster_name, importance_score,
 *     tldr_text, reason, scored_at, matched_message_count, to_me_addr,
 *     suggested_rating, suggestion_confidence, suggestion_reason,
 *     suggestion_scored_at }
 *
 * Phase 6.0.f added the suggested_* fields: latest LLM rating suggestion
 * across the thread (by scored_at), filtered to current classifier_version.
 */
async function getThreadByRfcIds(rfcIds) {
    if (!Array.isArray(rfcIds) || rfcIds.length === 0)
        return null;
    const cleaned = rfcIds.filter(Boolean);
    if (cleaned.length === 0)
        return null;
    const cacheKey = cleaned.slice().sort().join('|');
    const cached = _threadStateCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.state;
    }
    const qs = cleaned.map(s => encodeURIComponent(s)).join(',');
    const state = await _fetch('GET', `/thread?ids=${qs}`);
    if (state == null)
        return null;
    _threadStateCache.set(cacheKey, {
        state,
        expiresAt: Date.now() + THREAD_CACHE_TTL_MS,
    });
    return state;
}
/** Convenience: resolve thread → ids → getThreadByRfcIds. */
async function getThreadForMailspringThread(thread) {
    const ids = await rfcIdsForThread(thread);
    if (ids.length === 0)
        return null;
    return getThreadByRfcIds(ids);
}
// Subscribers notified after bustThreadCache so badges can re-fetch.
const _threadCacheListeners = new Set();
/** Subscribe to thread-cache busts. Returns an unsubscribe function. */
function onThreadCacheRefresh(cb) {
    _threadCacheListeners.add(cb);
    return () => _threadCacheListeners.delete(cb);
}
/** Drop cached state for any cache key that overlaps the given RFC IDs. */
function bustThreadCache(rfcIds) {
    const set = new Set((rfcIds || []).filter(Boolean));
    for (const key of _threadStateCache.keys()) {
        for (const id of set) {
            if (key.includes(id)) {
                _threadStateCache.delete(key);
                break;
            }
        }
    }
    for (const cb of _threadCacheListeners)
        cb();
}
// Periodic sweep — evict expired cache entries and notify badges so they
// re-fetch /thread for the rows still visible. Without this, a row that
// renders before the rating worker finishes caches "no rating yet" and
// never re-asks, even after the cache TTL passes, because Mailspring's
// virtualization doesn't re-mount on-screen rows.
const CACHE_SWEEP_INTERVAL_MS = 30 * 1000;
let _cacheSweepTimer = null;
function _sweepThreadCache() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of _threadStateCache) {
        if (entry.expiresAt <= now) {
            _threadStateCache.delete(key);
            removed++;
        }
    }
    if (removed > 0) {
        for (const cb of _threadCacheListeners)
            cb();
    }
}
if (!_cacheSweepTimer && typeof setInterval === 'function') {
    _cacheSweepTimer = setInterval(_sweepThreadCache, CACHE_SWEEP_INTERVAL_MS);
}
// ---------------------------------------------------------------------------
// /rate-message
/**
 * Record a manual tag. The plugin sends a Mailspring headerMessageId; sidecar
 * resolves to the warehouse PK and inserts a row.
 *
 *   payload: { rfc_message_id, rating, note, what_i_saw_on_screen,
 *              plugin_version }
 *
 * Returns the parsed response (always-200 contract; check `result.error`).
 * Returns null if the sidecar is unreachable.
 */
async function rateMessage(payload) {
    return _fetch('POST', '/rate-message', payload);
}
// ---------------------------------------------------------------------------
// /add-note
/**
 * Set the note on the latest message_ratings row for the given message.
 * Empty/whitespace note → clears (server-side normalization).
 *
 *   payload: { rfc_message_id, note }
 *
 * Returns parsed response; null if sidecar unreachable.
 */
async function addNote(payload) {
    return _fetch('POST', '/add-note', payload);
}
// ---------------------------------------------------------------------------
// /draft-event  (Phase 5)
//
// LLM-drafted event from an email. Sidecar shells out to `claude` so this
// is the slowest endpoint; we give it 30 seconds.
//
//   payload: { rfc_message_id }
//   returns: { source_message_id, title, description, proposed_start_iso,
//              duration_minutes, attendees: [{email, name?}], confidence,
//              error: str|null }
//   null on sidecar unreachable.
async function draftEvent(payload) {
    return _fetch('POST', '/draft-event', payload, { timeout: 30000 });
}
// ---------------------------------------------------------------------------
// /create-event  (Phase 5)
//
// Commits the (possibly user-edited) draft to Google Calendar and mirrors
// it into the warehouse. GCal latency is normally < 1s but we allow 10s
// to absorb refresh-token round trips.
//
//   payload: { rfc_message_id?, title, description?, start_iso,
//              duration_minutes, attendees: [{email, name?}],
//              calendar_pk?, plugin_version?, llm_drafted? }
//   returns: { calendar_event_id, gcal_event_id, html_link, title,
//              start_iso, end_iso, error: str|null }
//   null on sidecar unreachable.
async function createEvent(payload) {
    return _fetch('POST', '/create-event', payload, { timeout: 10000 });
}
// ---------------------------------------------------------------------------
// /route-suggest  (Phase 5.5.2)
//
// Asks the sidecar for an LLM routing suggestion (1 of 8 Routed/<name> folders
// or "none"). Cached server-side: repeat calls for the same message are cheap.
// First call per message triggers a Claude classification (~1-2s); subsequent
// reads return the cached row. Long timeout (15s) covers the cold-classify case.
//
//   payload: { rfc_message_id } OR { message_id }
//   returns: { message_id, suggested_folder, confidence, reason,
//              classifier_version, scored_at, error?: string }
//   null on sidecar unreachable.
async function routeSuggest(payload) {
    // Default to cached_only:true so the keystroke is instant. The sidecar's
    // background worker fills the cache; backfill CLI primes it. Caller can
    // pass cached_only:false explicitly to force an LLM call (e.g. a manual
    // "classify this one now" path), in which case bump the timeout.
    const body = (payload && typeof payload === 'object') ? Object.assign({}, payload) : {};
    if (body.cached_only === undefined)
        body.cached_only = true;
    const timeout = body.cached_only ? 3000 : 60000;
    return _fetch('POST', '/route-suggest', body, { timeout });
}
// ---------------------------------------------------------------------------
// /route-correction  (Phase 5.5.2)
//
// Logs an accept/override/manual decision so corrections become training
// signal for prompt + rules iteration.
//
//   payload: { rfc_message_id?, message_id?, suggested_folder, accepted_folder,
//              source: 'accept'|'override'|'manual', plugin_version }
//   returns: { correction_id, decided_at, source, message_id, error?: string }
//   null on sidecar unreachable.
async function routeCorrection(payload) {
    return _fetch('POST', '/route-correction', payload);
}
// ---------------------------------------------------------------------------
// Routing-suggestion in-memory cache.
//
// Keyed by RFC-822 ID (latest message in thread). 5 minute TTL — long enough
// that pressing Cmd+Option+Y immediately after the badge renders reuses the
// cached row, short enough that a prompt change picks up quickly. The cache
// is bypassed if the chip-render path passed a fresh suggestion in.
const _routeSuggestionCache = new Map();
const ROUTE_SUGGEST_TTL_MS = 5 * 60 * 1000;
function _cacheRouteSuggestion(rfcId, suggestion) {
    if (!rfcId || !suggestion)
        return;
    _routeSuggestionCache.set(rfcId, {
        suggestion,
        expiresAt: Date.now() + ROUTE_SUGGEST_TTL_MS,
    });
}
function _getCachedRouteSuggestion(rfcId) {
    const entry = _routeSuggestionCache.get(rfcId);
    if (!entry)
        return null;
    if (entry.expiresAt < Date.now()) {
        _routeSuggestionCache.delete(rfcId);
        return null;
    }
    return entry.suggestion;
}
/** Convenience: thread → last RFC ID → /route-suggest, with in-memory cache. */
async function getRouteSuggestionForThread(thread) {
    const ids = await rfcIdsForThread(thread);
    if (!ids || ids.length === 0)
        return null;
    // Latest message wins for routing — same grain as tag-keystroke-handler.
    const rfcId = ids[ids.length - 1];
    const cached = _getCachedRouteSuggestion(rfcId);
    if (cached)
        return cached;
    const result = await routeSuggest({ rfc_message_id: rfcId });
    if (result && result.suggested_folder) {
        _cacheRouteSuggestion(rfcId, result);
    }
    return result;
}
function bustRouteSuggestionCache(rfcIds) {
    for (const id of rfcIds || []) {
        if (id)
            _routeSuggestionCache.delete(id);
    }
}
/** Cache-only lookup — no HTTP, no LLM. Returns null if not cached. Used
 *  by the override path so a letter press is free unless Y was pressed
 *  on the same thread earlier in the session. */
async function getCachedRouteSuggestionForThread(thread) {
    const ids = await rfcIdsForThread(thread);
    if (!ids || ids.length === 0)
        return null;
    return _getCachedRouteSuggestion(ids[ids.length - 1]);
}
// ---------------------------------------------------------------------------
// /intake-now  (Phase 5.5.3)
//
// Triggers an incremental Mailspring→warehouse intake on the sidecar.
// Plugin-callable; the auto-intake module fires this after mailsync persists
// messages. Single-flight on the server side — concurrent calls return
// {busy:true} immediately. 60s timeout absorbs a slow initial sync burst.
//
//   returns: { messages_inserted, recipients_inserted, contacts_inserted,
//              folders_inserted, skipped_already_present, busy, error? }
//   null on sidecar unreachable.
async function intakeNow() {
    return _fetch('POST', '/intake-now', {}, { timeout: 60000 });
}
// ---------------------------------------------------------------------------
// /threads-enrich — bulk enrichment for the sort-view overlay.
/**
 * POST /threads-enrich. Returns { threads: [EnrichedThread, ...] } parallel
 * to input order, or null on transport failure. 5s timeout — typical
 * inbox view ≤ 200 ids and the SQL is one big SELECT.
 */
async function threadsEnrich(rfcMessageIds) {
    if (!Array.isArray(rfcMessageIds) || rfcMessageIds.length === 0) {
        return { threads: [] };
    }
    return _fetch('POST', '/threads-enrich', { rfc_message_ids: rfcMessageIds }, { timeout: 5000 });
}
// ---------------------------------------------------------------------------
// /message-lookup — RFC IDs → warehouse ids + metadata, for the debug HUD.
async function messageLookup(rfcMessageIds) {
    if (!Array.isArray(rfcMessageIds) || rfcMessageIds.length === 0) {
        return { messages: [] };
    }
    const qs = rfcMessageIds.map(s => encodeURIComponent(s)).join(',');
    return _fetch('GET', `/message-lookup?ids=${qs}`, undefined, { timeout: 3000 });
}
// ---------------------------------------------------------------------------
// /healthz
async function healthz() {
    return _fetch('GET', '/healthz');
}
// ---------------------------------------------------------------------------
// Exports
module.exports = {
    rfcIdsForThread,
    getThreadByRfcIds,
    getThreadForMailspringThread,
    onThreadCacheRefresh,
    bustThreadCache,
    rateMessage,
    addNote,
    draftEvent,
    createEvent,
    routeSuggest,
    routeCorrection,
    getRouteSuggestionForThread,
    getCachedRouteSuggestionForThread,
    bustRouteSuggestionCache,
    intakeNow,
    threadsEnrich,
    messageLookup,
    healthz,
    _resetSidecarWarning,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2lkZWNhci1jbGllbnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvc2lkZWNhci1jbGllbnQuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsb0JBQW9CO0FBQ3BCLEVBQUU7QUFDRixrRUFBa0U7QUFDbEUsRUFBRTtBQUNGLDBEQUEwRDtBQUMxRCw0RUFBNEU7QUFDNUUsaUVBQWlFO0FBQ2pFLDhFQUE4RTtBQUM5RSw4REFBOEQ7QUFDOUQsRUFBRTtBQUNGLGdCQUFnQjtBQUNoQix5RUFBeUU7QUFDekUsMEVBQTBFO0FBQzFFLHdFQUF3RTtBQUN4RSwyRUFBMkU7QUFDM0UsNEVBQTRFO0FBQzVFLGlFQUFpRTtBQUNqRSxtRUFBbUU7QUFDbkUsdUVBQXVFO0FBQ3ZFLGdFQUFnRTtBQUVoRSxNQUFNLEVBQUUsYUFBYSxFQUFFLE9BQU8sRUFBRSxHQUFHLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0FBRWpFLDhFQUE4RTtBQUM5RSxnQkFBZ0I7QUFFaEIsTUFBTSxnQkFBZ0IsR0FBRyx1QkFBdUIsQ0FBQztBQUNqRCxNQUFNLGdCQUFnQixHQUFHLElBQUksQ0FBQztBQUM5QixNQUFNLG1CQUFtQixHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFFdEMsa0RBQWtEO0FBQ2xELGdFQUFnRTtBQUNoRSxNQUFNLGVBQWUsR0FBRyxJQUFJLEdBQUcsRUFBRSxDQUFDO0FBQ2xDLE1BQU0saUJBQWlCLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQztBQUVwQywwREFBMEQ7QUFDMUQsK0JBQStCO0FBQy9CLE1BQU0saUJBQWlCLEdBQUcsSUFBSSxHQUFHLEVBQUUsQ0FBQztBQUVwQyxJQUFJLGtCQUFrQixHQUFHLEtBQUssQ0FBQztBQUUvQiw4RUFBOEU7QUFDOUUsa0NBQWtDO0FBQ2xDLEVBQUU7QUFDRix5RUFBeUU7QUFDekUsd0VBQXdFO0FBQ3hFLDZFQUE2RTtBQUM3RSx3RUFBd0U7QUFDeEUsc0VBQXNFO0FBQ3RFLGlEQUFpRDtB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