-- 11_effective_ratings.sql
-- Materialized per-message rating: the single 0–9 value the badge shows.
-- Populated by `populate_effective_ratings.py` after rating-classifier runs,
-- priority_friend floors, family floors, and manual overrides are resolved.
-- `source` tracks where the rating came from (e.g. "manual", "priority_friend",
-- "family_cluster", "rating_classifier", "cluster_default").
--
-- Depends on 00_warehouse_schema.sql (messages).

CREATE TABLE IF NOT EXISTS effective_ratings (
    message_id   INTEGER PRIMARY KEY REFERENCES messages(id),
    rating       INTEGER NOT NULL CHECK(rating >= 0 AND rating <= 9),
    source       TEXT NOT NULL,
    computed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_effective_ratings_rating
    ON effective_ratings(rating DESC);
