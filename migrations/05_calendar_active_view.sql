-- warehouse_calendar_active_view_migration.sql
-- Adds the `events_active` view: a sliding window over `events` covering
-- 5 years back to 1 year forward. The full `events` table is left intact
-- (lots of recurring birthdays/anniversaries got expanded by Google's
-- singleEvents=true out to 2056, which is correct but noisy).
--
-- Most queries should target `events_active` instead of `events`. The
-- window slides automatically on every query because it uses date('now',...).
--
-- Calendar_intake.py is also being updated to constrain future backfills
-- to this same window (BACKFILL_TIMEMIN = now-5y, BACKFILL_TIMEMAX = now+1y),
-- so far-future re-expansion won't grow the table on re-runs.
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < warehouse_calendar_active_view_migration.sql
--
-- IDEMPOTENCY: CREATE VIEW IF NOT EXISTS — safe to re-run.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- ============================================================================
-- events_active — the recommended query surface for "current" events.
--
-- Filters events to [now-5y, now+1y). Mirrors all events columns; downstream
-- joins (event_attendees, event_changes) still go through events.id because
-- views can't be referenced from foreign-key joins on the schema side, but
-- they work fine as the FROM/JOIN source in queries.
-- ============================================================================

CREATE VIEW IF NOT EXISTS events_active AS
SELECT
    *
FROM events
WHERE COALESCE(tombstone, 0) = 0
  AND start_iso IS NOT NULL
  AND start_iso >= date('now', '-5 years')
  AND start_iso <  date('now', '+1 year');

COMMIT;

-- ============================================================================
-- Post-migration validation:
--
--   sqlite3 warehouse.sqlite "SELECT COUNT(*) FROM events_active;"
--
-- Expected: a number much smaller than COUNT(*) FROM events (because the
-- far-future recurring expansions are filtered out).
-- ============================================================================
