// sort-patch.js
//
// Phase 1 — sticky native sort. Override Thread.naturalSortOrder so every
// default-sorted thread query (Inbox + Routed/* + any perspective that
// doesn't hardcode .order(...)) picks up the user's chosen sort. Source
// inspection in PHASE_0_VERDICT.md proves stickiness across persist
// events, scrolling, mark-as-read, etc. via MutableQuerySubscription's
// reuse of this._query.
//
// The override is read fresh each time ModelQuery.finalize() runs (see
// query.js:347-354). Fresh queries (perspective change, replaceQuery)
// pick up the new sort automatically. The currently-active subscription
// has already finalized its _query, so to apply a sort change without
// the user manually switching folders we clone the active query, clear
// _orders + _finalized, and call subscription.replaceQuery(clone).
//
// Public API:
//   activate()       — install the override; idempotent.
//   deactivate()     — restore Thread.naturalSortOrder; idempotent.
//   cycle()          — advance to the next dimension, re-apply, return label.
//   setByKey(key)    — set a specific dimension by key, re-apply, return label.
//   getCurrentLabel()
//   DIMENSIONS       — read-only list of {key, label}.

const { Thread } = require('mailspring-exports');

// Duck-typed SortOrder. Mailspring's query builder calls `.orderBySQL(klass)`
// and concatenates the result into the ORDER BY clause (proven from
// mailspring-app/src/flux/attributes/sort-order.js). No class inheritance
// required — any { orderBySQL: (klass) => string } works.
//
// Subject sort needs LOWER(LTRIM(...)) because mailers (Zillow, Wayfair,
// Pokémon, etc.) prefix subjects with whitespace (tab, double-space, single
// space) for visual padding. Raw ASCII byte-order sort puts TAB before
// space before letters, producing visually-broken ordering.
function subjectSortOrder(direction) {
  const dir = direction === 'DESC' ? 'DESC' : 'ASC';
  return {
    orderBySQL() {
      return "LOWER(LTRIM(`Thread`.`subject`, ' ' || CHAR(9) || CHAR(10) || CHAR(13))) " + dir;
    },
    // Some Mailspring code paths read `.attr` / `.dir` off SortOrder objects
    // for logging or attribute introspection. Provide best-effort shims.
    attr: Thread.attributes.subject,
    dir,
  };
}

// Duck-typed SortOrder that emits an arbitrary ORDER BY fragment. Used for
// warehouse-backed dimensions (sender, sent-to, rating) where the sort key
// lives in ATTACHed warehouse.sqlite rather than a queryable Thread attribute.
// The fragment is concatenated verbatim into the ORDER BY clause.
// `attr` must be a non-null object exposing `modelKey` because Mailspring's
// query optimizer (query.js:296 _canSubselectForJoin) does
// `orders.every(o => o.attr.modelKey in classAttrs)` — a null attr crashes
// the optimizer when our SortOrder reaches a fresh MutableQuerySubscription.
// Use a sentinel modelKey that is NOT a Thread attribute, so the subselect
// optimization is disabled (which we want — our ORDER BY references the
// ATTACHed warehouse and can't be subselected) but the iteration is safe.
const WAREHOUSE_ATTR_STUB = { modelKey: '__warehouse_sort__', jsonKey: '__warehouse_sort__' };

function warehouseSortOrder(sqlFragment) {
  return {
    orderBySQL() { return sqlFragment.trim(); },
    attr: WAREHOUSE_ATTR_STUB,
    dir: null,
  };
}

// Guard: if warehouse ATTACH hasn't succeeded yet (or failed at activate),
// substitute date_desc rather than emit a query that references warehouse.*
// tables and errors out. One warn per fallback fire so it's visible.
function _warehouseOrFallback(label, fragment) {
  if (!__warehouseAvailable) {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] warehouse unavailable; ' + label + ' falling back to date_desc');
    return Thread.attributes.lastMessageReceivedTimestamp.descending();
  }
  return warehouseSortOrder(fragment);
}

// Sender sort: pull sender_name from warehouse.messages joined via the
// most-recent message's headerMessageId. LOWER(LTRIM(...)) for the same
// whitespace-prefix reasons as subject sort. Secondary key:
// lastMessageReceivedTimestamp DESC for stable ordering across page
// boundaries when threads share a sender (or sender is NULL).
const SENDER_ASC_SQL = "(\
  SELECT LOWER(LTRIM(w.sender_name, ' ' || CHAR(9)))\
  FROM warehouse.messages w\
  WHERE w.message_id = (\
    SELECT m.headerMessageId\
    FROM `Message` m\
    WHERE m.threadId = `Thread`.`id`\
    ORDER BY m.date DESC\
    LIMIT 1\
  )\
) ASC, `Thread`.`lastMessageReceivedTimestamp` DESC";

const SENDER_DESC_SQL = "(\
  SELECT LOWER(LTRIM(w.sender_name, ' ' || CHAR(9)))\
  FROM warehouse.messages w\
  WHERE w.message_id = (\
    SELECT m.headerMessageId\
    FROM `Message` m\
    WHERE m.threadId = `Thread`.`id`\
    ORDER BY m.date DESC\
    LIMIT 1\
  )\
) DESC, `Thread`.`lastMessageReceivedTimestamp` DESC";

// Sent-to sort: which of the owner's email aliases received this thread's
// most-recent message. Sort key = the matching `recipients.addr` value.
//
// Schema notes (verified against warehouse_schema.sql 2026-05-12):
//   - recipients.message_id is INTEGER FK → messages.id (rowid), NOT
//     messages.message_id (RFC string). Two-level bridge required.
//   - No `to_position` column exists; use `recipients.id ASC` as insertion-
//     order proxy (intake parses To: header left-to-right).
//   - me_addresses.email is CHECK(email = LOWER(email)), so join with
//     LOWER(r.addr) on the right side only.
//   - Filter kind='to' (skip cc/bcc) and tombstone=0 on both messages and
//     recipients to match the rest of the warehouse query patterns.
const SENT_TO_INNER = "(\
  SELECT r.addr\
  FROM warehouse.recipients r\
  JOIN warehouse.me_addresses ma ON ma.email = LOWER(r.addr)\
  WHERE r.message_id = (\
    SELECT w.id FROM warehouse.messages w\
    WHERE w.message_id = (\
      SELECT m.headerMessageId FROM `Message` m\
      WHERE m.threadId = `Thread`.`id`\
      ORDER BY m.date DESC LIMIT 1\
    )\
    AND w.tombstone = 0\
    LIMIT 1\
  )\
  AND r.kind = 'to'\
  AND r.tombstone = 0\
  ORDER BY r.id ASC\
  LIMIT 1\
)";

const SENT_TO_ASC_SQL  = SENT_TO_INNER + " ASC, `Thread`.`lastMessageReceivedTimestamp` DESC";
const SENT_TO_DESC_SQL = SENT_TO_INNER + " DESC, `Thread`.`lastMessageReceivedTimestamp` DESC";

// Rating sort — Phase 2 first cut: latest manual rating from
// warehouse.message_ratings, COALESCE with sentinel so unrated threads sink
// to the bottom regardless of direction.
//
// Schema notes (verified against warehouse_schema.sql 2026-05-12):
//   - message_ratings.message_id is INTEGER FK → messages.id (rowid).
//     Same two-level bridge as recipients (NOT the RFC string column).
//   - rating is INTEGER 0–9, so -1 / 999 are safe out-of-range sentinels.
//   - Index idx_message_ratings_message(message_id, rated_at DESC) covers
//     the "latest rating per message" lookup directly.
//
// Sentinels:
//   - DESC (highest first):  unrated → -1  → end of list.
//   - ASC  (lowest first):   unrated → 999 → end of list.
//
// Phase 2.5 deferred: full effective_rating tier-logic (priority_friend,
// family cluster, CSV) — likely materialized as a shadow table fed by the
// sidecar's rating pipeline rather than computed inline.
// Rating sort uses the precomputed effective_ratings shadow table — the
// same tier-logic (manual > CSV > zero_value > priority_friend > family >
// cluster_default > zero) that drives the visible badges via
// /threads-enrich. Built by services/mml-classifier/.../populate_effective_ratings.py;
// re-run that script after rating changes to refresh.
//
// Aggregate per thread = MAX(rating) across all messages in the thread,
// joined warehouse.messages.message_id ↔ Mailspring Message.headerMessageId.
// "A thread is as important as its most-important message."
//
// Phase 2.6 follow-up: have the sidecar maintain effective_ratings
// incrementally on every rating / classification write so the table stays
// fresh without manual repopulation.
const RATING_INNER = "(\
  SELECT MAX(er.rating)\
  FROM warehouse.effective_ratings er\
  JOIN warehouse.messages w ON w.id = er.message_id AND w.tombstone = 0\
  JOIN `Message` m ON m.headerMessageId = w.message_id\
  WHERE m.threadId = `Thread`.`id`\
)";

const RATING_DESC_SQL = "COALESCE(" + RATING_INNER + ", -1) DESC, `Thread`.`lastMessageReceivedTimestamp` DESC";
const RATING_ASC_SQL  = "COALESCE(" + RATING_INNER + ", 999) ASC, `Thread`.`lastMessageReceivedTimestamp` DESC";

const DIMENSIONS = [
  {
    key: 'date_desc',
    label: 'Date received ↓',
    build: () => Thread.attributes.lastMessageReceivedTimestamp.descending(),
  },
  {
    key: 'date_asc',
    label: 'Date received ↑',
    build: () => Thread.attributes.lastMessageReceivedTimestamp.ascending(),
  },
  {
    key: 'subject_asc',
    label: 'Subject ↑',
    build: () => subjectSortOrder('ASC'),
  },
  {
    key: 'subject_desc',
    label: 'Subject ↓',
    build: () => subjectSortOrder('DESC'),
  },
  {
    key: 'sender_asc',
    label: 'Sender ↑',
    build: () => _warehouseOrFallback('sender_asc', SENDER_ASC_SQL),
  },
  {
    key: 'sender_desc',
    label: 'Sender ↓',
    build: () => _warehouseOrFallback('sender_desc', SENDER_DESC_SQL),
  },
  {
    key: 'sent_to_asc',
    label: 'Sent to ↑',
    build: () => _warehouseOrFallback('sent_to_asc', SENT_TO_ASC_SQL),
  },
  {
    key: 'sent_to_desc',
    label: 'Sent to ↓',
    build: () => _warehouseOrFallback('sent_to_desc', SENT_TO_DESC_SQL),
  },
  {
    key: 'rating_desc',
    label: 'Rating ↓ (highest first)',
    build: () => _warehouseOrFallback('rating_desc', RATING_DESC_SQL),
  },
  {
    key: 'rating_asc',
    label: 'Rating ↑ (lowest first)',
    build: () => _warehouseOrFallback('rating_asc', RATING_ASC_SQL),
  },
];

let __originalNaturalSortOrder = null;
let __currentIdx = 0; // start at date_desc — matches Mailspring's default
let __installed = false;
let __warehouseAvailable = false;

// Canonical local-first store. Matches other tools in this repo
// (extract_phase2.py, dump_rated_contacts.py, config.py:20). If the path
// changes, update all of them together.
const WAREHOUSE_PATH = '~/mml-productivity/warehouse.sqlite';

function isWarehouseAvailable() {
  return __warehouseAvailable;
}

// Fire-and-forget ATTACH at activate. Mailspring's DatabaseStore._query is
// async; activate() itself is sync (Mailspring's plugin lifecycle is sync).
// "database warehouse is already in use" is the expected success-on-retry
// case (see PHASE_1_HANDOFF §Task 3) — treat as available.
function _attachWarehouse() {
  let DatabaseStore;
  try {
    ({ DatabaseStore } = require('mailspring-exports'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] mailspring-exports unavailable; warehouse-backed sort disabled');
    return;
  }
  if (!DatabaseStore || typeof DatabaseStore._query !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] DatabaseStore._query missing; warehouse-backed sort disabled');
    return;
  }
  const escaped = WAREHOUSE_PATH.replace(/'/g, "''");
  const sql = "ATTACH DATABASE '" + escaped + "' AS warehouse";
  Promise.resolve()
    .then(() => DatabaseStore._query(sql))
    .then(() => {
      __warehouseAvailable = true;
      // eslint-disable-next-line no-console
      console.info('[mml-sort-patch] ATTACH warehouse OK; warehouse-backed sort available');
    })
    .catch((err) => {
      if (String(err).match(/already in use/i)) {
        // Prior ATTACH succeeded (renderer reload, second activate, etc.).
        __warehouseAvailable = true;
        // eslint-disable-next-line no-console
        console.info('[mml-sort-patch] warehouse already attached; available');
        return;
      }
      __warehouseAvailable = false;
      // eslint-disable-next-line no-console
      console.warn('[mml-sort-patch] ATTACH failed, warehouse-backed sort disabled:', err);
    });
}

function activate() {
  if (__installed) return;
  if (!Thread || typeof Thread.naturalSortOrder !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] Thread.naturalSortOrder unavailable; aborting install');
    return;
  }
  __originalNaturalSortOrder = Thread.naturalSortOrder;
  Thread.naturalSortOrder = () => DIMENSIONS[__currentIdx].build();
  __installed = true;
  _attachWarehouse();
  // eslint-disable-next-line no-console
  console.info('[mml-sort-patch] installed; default sort = ' + DIMENSIONS[__currentIdx].label);
}

function deactivate() {
  if (!__installed) return;
  try {
    if (__originalNaturalSortOrder) {
      Thread.naturalSortOrder = __originalNaturalSortOrder;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] failed to restore Thread.naturalSortOrder:', err);
  }
  __originalNaturalSortOrder = null;
  __installed = false;
}

// Locate ThreadListStore via require.cache walk. ThreadListStore is not
// exported from mailspring-exports — destructuring it silently yields
// undefined (sort-view-overlay.jsx:18-21 documents this). Same recipe as
// installOwnerRecipientColumn in main.js.
function _findThreadListStore() {
  const cache = require.cache || {};
  for (const key of Object.keys(cache)) {
    if (!key.endsWith('thread-list-store.js')) continue;
    const mod = cache[key];
    if (!mod || !mod.exports) continue;
    const exp = mod.exports;
    // Mailspring's compiled output uses ES-module-style default exports.
    return exp.default || exp.ThreadListStore || exp;
  }
  return null;
}

// Rebuild the ThreadListStore's data source so it picks up the patched
// Thread.naturalSortOrder. This calls FocusedPerspectiveStore.current()
// .threads() afresh, producing a brand-new MutableQuerySubscription whose
// ModelQuery is unfinalized — finalize() then reads the patched
// naturalSortOrder via query.js:347-354 the standard way.
//
// Why not the verdict's suggested subscription.replaceQuery(clone()) path:
// the verdict assumed `ThreadListStore.dataSource()._subscription` was the
// MutableQuerySubscription. It is not — that field is the RxJS observable
// subscription returned by observable-list-data-source.js:12. The actual
// MutableQuerySubscription is captured in the data source's observable
// closure and never re-exposed. createListDataSource() is the closest
// public-shaped path; it triggers a brief re-fetch flicker (same as a
// folder switch) but does not require reaching into private query state.
//
// Side effect: createListDataSource() clears the focused thread
// (thread-list-store.js:33). We capture and restore focus around the
// rebuild.
function _reapplyToActiveSubscription() {
  let store = null;
  try { store = _findThreadListStore(); } catch (_) {}
  if (!store) {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] ThreadListStore not in require.cache; sort change deferred to next perspective switch');
    return false;
  }
  if (typeof store.createListDataSource !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] store.createListDataSource missing; sort change deferred to next perspective switch');
    return false;
  }

  let focusedThread = null;
  try {
    const ms = require('mailspring-exports');
    focusedThread = ms.FocusedContentStore && ms.FocusedContentStore.focused
      ? ms.FocusedContentStore.focused('thread')
      : null;
  } catch (_) {}

  try {
    store.createListDataSource();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-sort-patch] createListDataSource threw:', err);
    return false;
  }

  if (focusedThread) {
    try {
      const ms = require('mailspring-exports');
      ms.Actions.setFocus({ collection: 'thread', item: focusedThread });
    } catch (_) {}
  }

  // eslint-disable-next-line no-console
  console.info('[mml-sort-patch] rebuilt thread-list data source for sort change');
  return true;
}

function getCurrentLabel() {
  return DIMENSIONS[__currentIdx].label;
}

function cycle() {
  __currentIdx = (__currentIdx + 1) % DIMENSIONS.length;
  _reapplyToActiveSubscription();
  return getCurrentLabel();
}

function setByKey(key) {
  const idx = DIMENSIONS.findIndex((d) => d.key === key);
  if (idx === -1) return null;
  __currentIdx = idx;
  _reapplyToActiveSubscription();
  return getCurrentLabel();
}

module.exports = {
  activate,
  deactivate,
  cycle,
  setByKey,
  getCurrentLabel,
  isWarehouseAvailable,
  DIMENSIONS: DIMENSIONS.map((d) => ({ key: d.key, label: d.label })),
};
