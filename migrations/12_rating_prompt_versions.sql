-- 12_rating_prompt_versions.sql
-- Mirror of 07_prompt_versions.sql, but for the *rating* classifier's
-- self-refinement loop (Phase 6.0.g). Each row records one deployed
-- version of the rating-suggest prompt and the meta-prompt audit that
-- produced it.
--
-- Depends on 08_rating_suggestions.sql (the rating-suggestion log this
-- refinement loop reads from).

CREATE TABLE IF NOT EXISTS rating_prompt_versions (
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

CREATE INDEX IF NOT EXISTS idx_rating_prompt_versions_created_at
    ON rating_prompt_versions(created_at DESC);
