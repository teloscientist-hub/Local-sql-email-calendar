-- warehouse_prompt_versions_migration.sql
-- Phase 5.5.5 schema addition for the MML Productivity warehouse.
--
-- Reason: introduces an audit trail for the self-refining routing prompt.
-- Each refinement run (manual or auto-triggered after N corrections)
-- materializes a new prompt file route_suggest_v{N+1}.md and inserts a row
-- here recording the parent version, the meta-LLM's JSON proposal, the model
-- used, and the correction count at trigger time. Rollback is a manual
-- write to prompts/CURRENT_VERSION.txt — this table is the audit log,
-- not the source-of-truth for "what's deployed."
--
-- USAGE:
--   sqlite3 "../../warehouse.sqlite" < warehouse_prompt_versions_migration.sql
--
-- IDEMPOTENCY: CREATE TABLE IF NOT EXISTS — safe to re-run.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS routing_prompt_versions (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    version                     TEXT NOT NULL UNIQUE,
    prompt_path                 TEXT NOT NULL,
    parent_version              TEXT,
    refinement_meta_json        TEXT,
    refinement_model            TEXT,
    correction_count_at_trigger INTEGER,
    created_at                  TEXT NOT NULL,
    deployed_at                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_routing_prompt_versions_created_at
    ON routing_prompt_versions(created_at DESC);

COMMIT;
