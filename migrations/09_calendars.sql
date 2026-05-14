-- 09_calendars.sql
-- Adds a `calendars` table tracking each Google Calendar the owner syncs.
-- One row per (google_account, gcal_calendar_id). Used by calendar_intake
-- and event_creator to know which calendar to write to and what sync token
-- to resume from.
--
-- Depends on 04_calendar.sql (events table).

CREATE TABLE IF NOT EXISTS calendars (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    google_account    TEXT NOT NULL,
    gcal_calendar_id  TEXT NOT NULL,
    display_name      TEXT,
    description       TEXT,
    timezone          TEXT,
    is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    is_primary        INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    sync_token        TEXT,
    source            TEXT NOT NULL DEFAULT 'google',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at         TEXT,
    ingester_version  TEXT,
    tombstone         INTEGER NOT NULL DEFAULT 0,
    UNIQUE(google_account, gcal_calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_calendars_default
    ON calendars(is_default) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_calendars_primary
    ON calendars(is_primary) WHERE is_primary = 1;
