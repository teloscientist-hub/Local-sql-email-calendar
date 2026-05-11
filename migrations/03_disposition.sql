-- warehouse_disposition_migration.sql
-- Phase 0.5 schema change for the MML Productivity warehouse.
--
-- Reason: rev 2 of the Phase 1 spike plan reframes the "done state" model
-- from a 3-value enum (complete | pending | cleared) into a free-form
-- disposition-folder model (Pending | Waiting | Done | Later | future...).
-- The plugin moves threads into named folders; the warehouse mirrors
-- the destination folder name as the canonical disposition value.
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < warehouse_disposition_migration.sql
--   <validate via post-migration queries at bottom>
--
-- IDEMPOTENCY: this script is NOT idempotent. It expects messages_status
-- to be in its rev-1 shape (status TEXT CHECK in ('complete','pending','cleared')).
-- If re-run, the rename to messages_status_new will fail.
--
-- DATA: messages_status was empty post-Phase-0 (no rows), so the row
-- migration step below is a no-op in practice but is written safely so
-- the script also works if rows have appeared.
--

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

-- ============================================================================
-- Step 1: Create the new shape of messages_status.
-- - Column renamed: status -> disposition
-- - CHECK constraint dropped: free-form, stores the destination folder's
--   displayName ('Pending', 'Waiting', 'Done', 'Later', or future). NULL means
--   no disposition (lives in Inbox / unset).
-- - All other columns and append-only semantics preserved: current state per
--   message is the row with MAX(set_at).
-- ============================================================================

CREATE TABLE messages_status_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id       INTEGER NOT NULL REFERENCES messages(id),
    disposition      TEXT,
    set_at           TEXT NOT NULL,
    set_by           TEXT,
    source_path      TEXT,
    ingester_version TEXT
);

-- ============================================================================
-- Step 2: Copy rows, mapping old values onto the new disposition vocabulary.
--   'pending'  -> 'Pending'
--   'complete' -> 'Complete'  (Gmail reserves 'Done' as a system label and
--                              blocks user-create, so we use 'Complete'
--                              everywhere for cross-provider consistency)
--   'cleared'  -> NULL          (cleared meant "back to inbox / unset")
-- Any unexpected value (defensive default) is copied as-is so it can be
-- inspected after migration.
-- ============================================================================

INSERT INTO messages_status_new (id, message_id, disposition, set_at, set_by, source_path, ingester_version)
SELECT
    id,
    message_id,
    CASE status
        WHEN 'pending'  THEN 'Pending'
        WHEN 'complete' THEN 'Complete'
        WHEN 'cleared'  THEN NULL
        ELSE status
    END AS disposition,
    set_at,
    set_by,
    source_path,
    ingester_version
FROM messages_status;

-- ============================================================================
-- Step 3: Swap tables.
-- ============================================================================

DROP TABLE messages_status;
ALTER TABLE messages_status_new RENAME TO messages_status;

-- ============================================================================
-- Step 4: Recreate the lookup index that we dropped with the old table.
-- Same shape as the rev-1 schema: per-message, latest-first.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_msgstatus_msg ON messages_status(message_id, set_at DESC);

COMMIT;

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Post-migration validation queries. Run manually after the script:
--
--   sqlite3 warehouse.sqlite "
--     -- shape: confirm the new column exists, no CHECK
--     SELECT sql FROM sqlite_master WHERE name='messages_status';
--   "
--
--   sqlite3 warehouse.sqlite "
--     -- distribution: should show the new vocabulary only (or NULL)
--     SELECT disposition, COUNT(*) FROM messages_status GROUP BY disposition;
--   "
--
--   sqlite3 warehouse.sqlite "
--     -- sanity: any value not in the expected set?
--     SELECT DISTINCT disposition FROM messages_status
--      WHERE disposition IS NOT NULL
--        AND disposition NOT IN ('Pending','Waiting','Complete','Later');
--   "
--
-- The third query should return zero rows. If it returns anything, that's
-- a row that was in the old table with an unexpected status value; review
-- and either delete or remap manually.
-- ============================================================================
