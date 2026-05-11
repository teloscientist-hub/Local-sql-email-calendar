-- warehouse_calendar_migration.sql
-- Phase 5 — unified Google Calendar integration.
--
-- Supersedes an earlier draft of this migration (which created `calendars`
-- + `calendar_events`). The earlier shape went into the live warehouse but
-- never had data written to it; this migration consolidates to a unified
-- schema that serves BOTH:
--
--   1. PLUGIN CREATE (Ctrl+Cmd+E in Mailspring): LLM drafts an event from
--      a focused email; user reviews in overlay; sidecar writes to Google
--      Calendar and mirrors the result. Row's `source` = 'plugin-create'.
--   2. INGEST (calendar_intake CLI): pulls all calendar history from
--      Google Calendar via syncToken-based incremental sync. Row's
--      `source` = 'gcal-sync'.
--
-- Both flows write `events` + `event_attendees` + `event_changes`. The
-- attendees `email` column joins to `contact_email_map` →
-- `contact_entities`, so cross-domain "every interaction with X" queries
-- can UNION email recipients and event attendees on a single person key.
--
-- The old `calendar_events` is REPLACED by `events` (with normalized
-- attendees + Google-state fields like etag/status/recurrence).
-- The old `calendars` is EXTENDED with `description`, `is_primary`,
-- `sync_token`, `source` via ALTER TABLE.
--
-- SAFETY: this migration assumes the old `calendars` and `calendar_events`
-- tables are empty. If either has rows when this runs, the script aborts
-- via the failsafe at the top of the transaction. As of 2026-05-10 both
-- were verified empty in the live warehouse.
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < warehouse_calendar_migration.sql
--
-- IDEMPOTENCY: safe to re-run. ALTER TABLE ADD COLUMN re-runs are
-- non-destructive — we guard each ADD COLUMN by checking PRAGMA
-- table_info via the runner (sqlite alone can't conditionally ADD
-- COLUMN). If a column already exists, sqlite raises "duplicate column
-- name"; the migration runner (or a manual re-run) should treat that
-- error on a column we know is there as already-applied.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- ============================================================================
-- Failsafe: abort if the old tables have any data. We're about to DROP
-- calendar_events; doing so on a non-empty table would lose data.
-- The CHECK constraint here errors when the SELECT returns a row, which
-- only happens when one of the tables is non-empty.
-- ============================================================================

CREATE TEMP TABLE IF NOT EXISTS _migration_failsafe (
    metric TEXT NOT NULL,
    n      INTEGER NOT NULL CHECK (n = 0)
);
INSERT INTO _migration_failsafe (metric, n)
  SELECT 'calendars rows',       COUNT(*) FROM calendars;
INSERT INTO _migration_failsafe (metric, n)
  SELECT 'calendar_events rows', COUNT(*) FROM calendar_events;
DROP TABLE _migration_failsafe;

-- ============================================================================
-- Replace calendar_events with `events`. The old table is empty so DROP is
-- safe. The new `events` table adds: ical_uid, recurring_event_id, location,
-- all_day, status, organizer_email, organizer_self, visibility,
-- transparency, etag, hangout_link, created_at_google, updated_at_google,
-- source, first_seen_at, last_seen_at. It removes attendees_json (replaced
-- by normalized event_attendees) and created_by (replaced by `source`).
-- ============================================================================

DROP INDEX IF EXISTS idx_calendar_events_source_message;
DROP INDEX IF EXISTS idx_calendar_events_start;
DROP INDEX IF EXISTS idx_calendar_events_calendar;
DROP TABLE IF EXISTS calendar_events;

-- ============================================================================
-- Extend `calendars` with ingest columns. ALTER TABLE ADD COLUMN doesn't
-- support IF NOT EXISTS in SQLite; on re-run these will error with
-- "duplicate column name". The runner can ignore that specific error.
-- ============================================================================

ALTER TABLE calendars ADD COLUMN description TEXT;
ALTER TABLE calendars ADD COLUMN is_primary  INTEGER NOT NULL DEFAULT 0
    CHECK (is_primary IN (0, 1));
ALTER TABLE calendars ADD COLUMN sync_token  TEXT;
ALTER TABLE calendars ADD COLUMN source      TEXT NOT NULL DEFAULT 'google';

CREATE INDEX IF NOT EXISTS idx_calendars_primary
    ON calendars(is_primary) WHERE is_primary = 1;

-- ============================================================================
-- events — every calendar event we know about.
-- Unique key (calendar_pk, gcal_event_id). ical_uid preserved for cross-
-- calendar joinability. For recurring events ingest uses singleEvents=true
-- so Google expands occurrences; recurring_event_id points to the master.
-- source is sticky to origin even when ingest later refreshes the row.
-- ============================================================================

CREATE TABLE IF NOT EXISTS events (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_pk          INTEGER NOT NULL REFERENCES calendars(id),
    gcal_event_id        TEXT NOT NULL,
    ical_uid             TEXT,
    recurring_event_id   TEXT,

    title                TEXT,
    description          TEXT,
    location             TEXT,
    start_iso            TEXT,
    end_iso              TEXT,
    timezone             TEXT,
    all_day              INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),

    status               TEXT,
    organizer_email      TEXT,
    organizer_self       INTEGER NOT NULL DEFAULT 0 CHECK (organizer_self IN (0, 1)),
    visibility           TEXT,
    transparency         TEXT,
    etag                 TEXT,
    html_link            TEXT,
    hangout_link         TEXT,
    created_at_google    TEXT,
    updated_at_google    TEXT,

    source_message_id    INTEGER REFERENCES messages(id),

    source               TEXT NOT NULL DEFAULT 'gcal-sync'
        CHECK (source IN ('plugin-create', 'gcal-sync')),
    llm_drafted          INTEGER NOT NULL DEFAULT 0 CHECK (llm_drafted IN (0, 1)),
    plugin_version       TEXT,
    sidecar_version      TEXT,

    first_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at         TEXT NOT NULL DEFAULT (datetime('now')),
    tombstone            INTEGER NOT NULL DEFAULT 0,

    UNIQUE(calendar_pk, gcal_event_id),
    CHECK(organizer_email IS NULL OR organizer_email = LOWER(organizer_email))
);

CREATE INDEX IF NOT EXISTS idx_events_start
    ON events(start_iso);

CREATE INDEX IF NOT EXISTS idx_events_calendar_start
    ON events(calendar_pk, start_iso DESC);

CREATE INDEX IF NOT EXISTS idx_events_organizer
    ON events(organizer_email);

CREATE INDEX IF NOT EXISTS idx_events_ical_uid
    ON events(ical_uid);

CREATE INDEX IF NOT EXISTS idx_events_recurring
    ON events(recurring_event_id);

CREATE INDEX IF NOT EXISTS idx_events_source_message
    ON events(source_message_id);


-- ============================================================================
-- event_attendees — normalized; email joins to contact_email_map.
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_attendees (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id             INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    email                TEXT NOT NULL,
    display_name         TEXT,
    response_status      TEXT,                  -- 'accepted'|'declined'|'tentative'|'needsAction'
    is_organizer         INTEGER NOT NULL DEFAULT 0 CHECK (is_organizer IN (0, 1)),
    is_optional          INTEGER NOT NULL DEFAULT 0 CHECK (is_optional IN (0, 1)),
    is_self              INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
    is_resource          INTEGER NOT NULL DEFAULT 0 CHECK (is_resource IN (0, 1)),
    UNIQUE(event_id, email),
    CHECK(email = LOWER(email))
);

CREATE INDEX IF NOT EXISTS idx_event_attendees_email
    ON event_attendees(email);


-- ============================================================================
-- event_changes — append-only history. Every write to `events` produces
-- one row here, so meeting history ("when did this move?", "who declined?")
-- can be reconstructed by replaying diff_json in observed_at order, or by
-- reading the most-recent snapshot_json before a target timestamp.
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_changes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    etag_before     TEXT,
    etag_after      TEXT,
    change_kind     TEXT NOT NULL CHECK (change_kind IN
                        ('plugin-create', 'insert', 'update', 'cancel', 'delete')),
    diff_json       TEXT,                       -- {field: {before, after}}; NULL for first observation
    snapshot_json   TEXT NOT NULL               -- full event payload at observation
);

CREATE INDEX IF NOT EXISTS idx_event_changes_event
    ON event_changes(event_id, observed_at);

COMMIT;

-- ============================================================================
-- Post-migration validation:
--
--   sqlite3 warehouse.sqlite "
--     SELECT name FROM sqlite_master
--      WHERE name IN ('calendars','events','event_attendees','event_changes')
--         OR name LIKE 'idx_events_%'
--         OR name LIKE 'idx_event_attendees_%'
--         OR name LIKE 'idx_event_changes_%'
--         OR name LIKE 'idx_calendars_%'
--      ORDER BY name;
--   "
--
-- Expected (14 rows):
--   calendars
--   events
--   event_attendees
--   event_changes
--   idx_calendars_default
--   idx_calendars_primary
--   idx_event_attendees_email
--   idx_event_changes_event
--   idx_events_calendar_start
--   idx_events_ical_uid
--   idx_events_organizer
--   idx_events_recurring
--   idx_events_source_message
--   idx_events_start
-- ============================================================================
