-- warehouse_message_ratings_migration.sql
-- Phase 2.5 schema addition for the MML Productivity warehouse.
--
-- Reason: Phase 2 gives every message an effective rating via the fallback
-- chain (per-contact CSV → zero-value sender → cluster default). What it
-- does NOT support is per-message manual override or correction — the
-- owner can't say "this specific email is a 3, not a 7." Phase 2.5 adds
-- a 0–9 keystroke set in the Mailspring plugin that writes one row here
-- per tag, with the system's prior rating/cluster captured for the
-- active-learning corpus.
--
-- The optional `note` column carries the WHY of a rating ("this is a
-- promo blast, not a personal email"). When present, it suppresses the
-- per-contact CSV update — the tag is treated as context-conditional
-- and feeds the rule-mining loop (see docs/FUTURE_IMPROVEMENTS.md
-- "Explicit tag-to-rule translation process") rather than resetting the
-- sender's baseline.
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < 02_message_ratings.sql
--
-- IDEMPOTENCY: uses CREATE TABLE/INDEX IF NOT EXISTS — safe to re-run.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- ============================================================================
-- message_ratings — APPEND-ONLY.
--
-- One row per manual-tag keystroke. Re-tagging the same message inserts
-- a new row; latest by rated_at DESC wins at read time.
--
-- rating: 0–9. 0 is a deliberate "explicit zero-value" signal (different
-- from null/missing).
--
-- note: optional context. Presence flips the tag from "baseline reset
-- for this sender" to "context-conditional signal" — the per-contact
-- CSV update is suppressed and the row joins the rule-mining corpus.
--
-- system_rating_at_time / system_cluster_at_time: snapshot of what the
-- system showed the owner at the moment of the keystroke. Disagreement
-- (rating != system_rating_at_time) is the active-learning signal.
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_ratings (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id              INTEGER NOT NULL REFERENCES messages(id),
    rating                  INTEGER NOT NULL CHECK(rating >= 0 AND rating <= 9),
    note                    TEXT,
    rated_at                TEXT NOT NULL,
    system_rating_at_time   INTEGER,
    system_cluster_at_time  INTEGER,
    source                  TEXT NOT NULL DEFAULT 'plugin-keystroke',
    plugin_version          TEXT,
    sidecar_version         TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_ratings_message
    ON message_ratings(message_id, rated_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_ratings_recent
    ON message_ratings(rated_at DESC);

COMMIT;

-- ============================================================================
-- Post-migration validation:
--
--   sqlite3 warehouse.sqlite "
--     SELECT sql FROM sqlite_master WHERE name='message_ratings';
--     SELECT COUNT(*) AS rows FROM message_ratings;
--   "
-- ============================================================================
