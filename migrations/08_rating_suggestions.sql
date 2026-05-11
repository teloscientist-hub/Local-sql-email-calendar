-- warehouse_rating_suggestions_migration.sql
-- Phase 6.0 schema addition for the MML Productivity warehouse.
--
-- Reason: introduces LLM-derived rating suggestions (0-9) for new mail,
-- mirroring the routing_suggestions architecture from Phase 5.5.2. Each
-- suggestion is one Claude classification call's worth of output:
-- {rating, confidence, reason, classifier_version}. Append-only — a
-- re-classification (prompt version bump) inserts a new row.
--
-- The owner's actual rating (Ctrl+Option+<digit>) lives in message_ratings;
-- THIS table holds the LLM's GUESS. They get compared automatically:
-- if the manual rating matches the suggestion, source='accept'; if
-- different, source='override'. The mismatch signal is what trains the
-- next prompt version (via the Phase 5.5.5 self-refinement analog).
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < 08_rating_suggestions.sql
--
-- IDEMPOTENCY: uses CREATE TABLE IF NOT EXISTS — safe to re-run.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS rating_suggestions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id         INTEGER NOT NULL REFERENCES messages(id),
    suggested_rating   INTEGER NOT NULL CHECK(suggested_rating >= 0 AND suggested_rating <= 9),
    confidence         REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
    reason             TEXT,
    classifier_version TEXT NOT NULL,
    scored_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rating_suggestions_msg
    ON rating_suggestions(message_id, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_rating_suggestions_classifier_version
    ON rating_suggestions(classifier_version, scored_at DESC);

COMMIT;
