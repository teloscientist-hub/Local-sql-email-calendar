-- warehouse_routing_migration.sql
-- Phase 5.5.2 schema addition for the MML Productivity warehouse.
--
-- Reason: introduces LLM-based routing suggestions for the configured
-- Routed/<name> folders (see services/.../config.py ROUTING_FOLDERS), plus
-- a record of every accept/override decision so corrections become
-- training signal for prompt + rules iteration.
--
-- Two new tables, both append-only:
--   routing_suggestions  — one row per LLM classification
--   routing_corrections  — one row per accept/override/manual decision
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < warehouse_routing_migration.sql
--
-- IDEMPOTENCY: uses CREATE TABLE IF NOT EXISTS — safe to re-run.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- ============================================================================
-- routing_suggestions — APPEND-ONLY.
--
-- One row per LLM evaluation. Re-classification (prompt-version bump, model
-- swap) inserts a new row; current suggestion per message is the row with
-- MAX(scored_at) (or MAX(id) as a deterministic tiebreaker).
--
-- suggested_folder: the recommended destination, free-form text. Conventional
--   values: 'Routed/<X>' where <X> is one of the names in
--   services/.../config.py ROUTING_FOLDERS, or 'none' when the LLM
--   declines to commit. Stored verbatim so the folder set can change
--   later without a schema change.
-- confidence: 0.0..1.0; nullable.
-- reason: short rationale from the LLM; not displayed in UI.
-- ============================================================================

CREATE TABLE IF NOT EXISTS routing_suggestions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id         INTEGER NOT NULL REFERENCES messages(id),
    suggested_folder   TEXT NOT NULL,
    confidence         REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
    reason             TEXT,
    classifier_version TEXT NOT NULL,
    scored_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_suggestions_msg
    ON routing_suggestions(message_id, scored_at DESC);

-- ============================================================================
-- routing_corrections — APPEND-ONLY.
--
-- One row per disposition decision originating from the plugin. Captures
-- both agreements (source='accept') and disagreements (source='override')
-- between the LLM and the user, plus pure-manual moves where no suggestion
-- was in scope (source='manual').
--
-- source values:
--   'accept'    — user accepted the LLM suggestion (Cmd+Option+Y).
--   'override'  — user picked a different folder via Cmd+Option+<letter>.
--   'manual'    — no suggestion was available; user moved unaided.
-- ============================================================================

CREATE TABLE IF NOT EXISTS routing_corrections (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id         INTEGER NOT NULL REFERENCES messages(id),
    suggested_folder   TEXT,
    accepted_folder    TEXT NOT NULL,
    source             TEXT NOT NULL CHECK(source IN ('accept','override','manual')),
    classifier_version TEXT,
    plugin_version     TEXT,
    decided_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_corrections_msg
    ON routing_corrections(message_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_routing_corrections_decided_at
    ON routing_corrections(decided_at DESC);

COMMIT;

-- ============================================================================
-- Post-migration validation:
--
--   sqlite3 warehouse.sqlite "
--     SELECT sql FROM sqlite_master WHERE name IN ('routing_suggestions','routing_corrections');
--     SELECT COUNT(*) AS suggestions_rows FROM routing_suggestions;
--     SELECT COUNT(*) AS corrections_rows FROM routing_corrections;
--   "
-- ============================================================================
