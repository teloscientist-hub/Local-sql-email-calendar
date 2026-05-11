-- warehouse_content_scores_migration.sql
-- Phase 2 schema addition for the MML Productivity warehouse.
--
-- Reason: the Phase 2 vision adds a third triage layer — for emails
-- that don't have a relationship rating (rating=0/null) AND fall into
-- a "fall-through" cluster (29 newsletters / 30 transactional / 31
-- cold inbound), the classifier sidecar runs Claude over the body to
-- compute an importance score (0-1) and an optional TLDR. This is
-- distinct from cluster classification (which lives in `classifications`)
-- so it gets its own append-only table.
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < 01_content_scores.sql
--
-- IDEMPOTENCY: uses CREATE TABLE IF NOT EXISTS — safe to re-run.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- ============================================================================
-- content_scores — APPEND-ONLY.
--
-- One row per LLM evaluation of a message. Re-scoring (e.g. after a
-- scorer-version bump or a model change) inserts a new row; current
-- score per message is the row with MAX(scored_at).
--
-- importance_score: 0.0 (definitely skip) → 1.0 (definitely show).
-- tldr_text: NULL when importance is below the show-threshold (we don't
-- waste tokens on TLDRs we won't display) or when the model declined.
-- reason: short rationale for audit/debug; not displayed in UI.
-- ============================================================================

CREATE TABLE IF NOT EXISTS content_scores (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id       INTEGER NOT NULL REFERENCES messages(id),
    importance_score REAL NOT NULL CHECK(importance_score >= 0.0 AND importance_score <= 1.0),
    tldr_text        TEXT,
    reason           TEXT,
    scorer_version   TEXT NOT NULL,
    scored_at        TEXT NOT NULL,
    source_path      TEXT,
    ingester_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_content_scores_msg
    ON content_scores(message_id, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_scores_importance
    ON content_scores(importance_score DESC);

COMMIT;

-- ============================================================================
-- Post-migration validation:
--
--   sqlite3 warehouse.sqlite "
--     SELECT sql FROM sqlite_master WHERE name='content_scores';
--     SELECT COUNT(*) AS rows FROM content_scores;
--   "
-- ============================================================================
