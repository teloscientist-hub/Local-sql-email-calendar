-- 00_warehouse_schema.sql
-- Canonical end-state DDL for warehouse.sqlite — what every other table sees.
--
-- Run this against a fresh empty SQLite file to bootstrap the warehouse:
--   sqlite3 warehouse.sqlite < migrations/00_warehouse_schema.sql
--
-- For evolving an existing warehouse through phase boundaries, see the numbered
-- migration scripts (01_..05_) which document the historical evolution.
--
-- Conventions:
--   * The person is the central record (contact_entities). Email is a data
--     field attached to a person via contact_email_map. Many emails → one
--     person.
--   * "Me" / "owner" = the human running this system (you).
--   * me_addresses is the set of email addresses YOU send from. Multiple
--     accounts/aliases are normal.
--   * Append-only with provenance for derived/decision tables. Bronze tables
--     (messages, recipients) keep edits in place.
--   * All email addresses lowercased on insert; CHECK enforces it.
--   * Tombstone column on tables that support soft-delete; never hard-delete.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================================
-- BRONZE: source provenance for original PST/mbox imports.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pst_sources (
    id               INTEGER PRIMARY KEY,
    filename         TEXT NOT NULL,
    full_path        TEXT NOT NULL,
    size_bytes       INTEGER,
    imported_at      TEXT,
    ingester_version TEXT,
    parser_version   TEXT
);

-- ============================================================================
-- Folder hierarchy from PST/mbox sources.
-- ============================================================================

CREATE TABLE IF NOT EXISTS folders (
    id               INTEGER PRIMARY KEY,
    pst_source_id    INTEGER NOT NULL REFERENCES pst_sources(id),
    parent_folder_id INTEGER REFERENCES folders(id),
    name             TEXT NOT NULL,
    full_path        TEXT NOT NULL,
    depth            INTEGER NOT NULL DEFAULT 0,
    tombstone        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_folders_pst  ON folders(pst_source_id);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(full_path);

-- ============================================================================
-- Email messages.
-- Provenance traced through pst_source_id FK.
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY,
    pst_source_id  INTEGER NOT NULL REFERENCES pst_sources(id),
    folder_id      INTEGER REFERENCES folders(id),
    message_id     TEXT,                           -- RFC-822 Message-ID
    in_reply_to    TEXT,
    subject        TEXT,
    sender_name    TEXT,
    sender_addr    TEXT,
    sent_date      TEXT,
    received_date  TEXT,
    body_plain     TEXT,
    body_html      TEXT,
    body_rtf       TEXT,
    source_file    TEXT,
    parser_version TEXT,
    tombstone      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_pst    ON messages(pst_source_id);
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_addr);
CREATE INDEX IF NOT EXISTS idx_messages_sent   ON messages(sent_date);
CREATE INDEX IF NOT EXISTS idx_messages_msgid  ON messages(message_id);

-- ============================================================================
-- Per-message recipients (To/CC/BCC).
-- ============================================================================

CREATE TABLE IF NOT EXISTS recipients (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    kind       TEXT NOT NULL CHECK(kind IN ('to','cc','bcc')),
    name       TEXT,
    addr       TEXT,
    tombstone  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recipients_msg  ON recipients(message_id);
CREATE INDEX IF NOT EXISTS idx_recipients_addr ON recipients(addr);

-- ============================================================================
-- Person records. The unit of identity.
-- One row per person (or per list-as-its-own-contact, e.g. "[Some List]").
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_entities (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name   TEXT NOT NULL,
    canonical_email  TEXT,
    notes            TEXT,
    is_me            INTEGER NOT NULL DEFAULT 0,   -- 1 = this contact is YOU
    is_list_addr     INTEGER NOT NULL DEFAULT 0,   -- 1 = list/distribution addr
    created_at       TEXT,
    updated_at       TEXT,
    ingester_version TEXT,
    tombstone        INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- Email-to-person mapping. Many emails per contact_entity.
-- Email is lowercased; CHECK enforces it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_email_map (
    email                TEXT PRIMARY KEY CHECK(email = LOWER(email)),
    contact_entity_id    INTEGER NOT NULL REFERENCES contact_entities(id),
    primary_for_contact  INTEGER NOT NULL DEFAULT 0,
    first_seen_at        TEXT,
    last_seen_at         TEXT,
    tombstone            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cem_entity ON contact_email_map(contact_entity_id);

-- ============================================================================
-- Your sending addresses. Reference table identifying "you sent this" for
-- engagement counting. Populate this BEFORE running the engagement bootstrap.
-- ============================================================================

CREATE TABLE IF NOT EXISTS me_addresses (
    email             TEXT PRIMARY KEY CHECK(email = LOWER(email)),
    contact_entity_id INTEGER REFERENCES contact_entities(id),
    notes             TEXT,
    added_at          TEXT
);

-- ============================================================================
-- Cluster taxonomy reference. Populate from docs/CLASSIFICATION_TAXONOMY.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cluster_definitions (
    cluster_id         INTEGER PRIMARY KEY CHECK(cluster_id BETWEEN 1 AND 31),
    cluster_name       TEXT NOT NULL UNIQUE,
    main_category      TEXT NOT NULL CHECK(main_category IN (
                          'personal',
                          'clients',
                          'work',
                          'business logistics',
                          'inbound-native'
                       )),
    definition_md      TEXT,
    created_at         TEXT,
    definition_version TEXT
);

-- ============================================================================
-- Per-sender classification. ONE row per sender_addr.
-- Output of the Phase-1 sender-level pass over historical mail.
-- cluster_id NULL = MIXED → the sender's mail must be classified per-message.
-- priority_friend flag = sender auto-rates high regardless of cluster.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sender_classifications (
    id              INTEGER PRIMARY KEY,
    sender_addr     TEXT NOT NULL UNIQUE,
    cluster_id      INTEGER,
    cluster         TEXT,
    confidence      TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
    reason          TEXT,
    msg_count       INTEGER NOT NULL,
    classified_at   TEXT NOT NULL,
    classified_by   TEXT NOT NULL,             -- 'phase1_agent' | 'manual'
    model           TEXT,
    priority_friend INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sndcls_cluster ON sender_classifications(cluster_id);

-- ============================================================================
-- Per-message classification. Output of the Phase-2 pass on MIXED senders
-- and any message that needs override of its sender's cluster.
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_classifications (
    id            INTEGER PRIMARY KEY,
    message_id    INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    cluster_id    INTEGER NOT NULL,
    cluster       TEXT NOT NULL,
    owner_role    TEXT,                        -- 'sender'|'to'|'cc'|'none' (your role in the msg)
    confidence    TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
    reason        TEXT,
    source        TEXT NOT NULL CHECK(source IN ('phase1_sender','phase2_email','auto_rule','manual')),
    classified_at TEXT NOT NULL,
    model         TEXT
);

CREATE INDEX IF NOT EXISTS idx_msgcls_cluster ON message_classifications(cluster_id);
CREATE INDEX IF NOT EXISTS idx_msgcls_source  ON message_classifications(source);

-- ============================================================================
-- Classification batch tracking. One row per batch input/results file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS classification_batches (
    id           INTEGER PRIMARY KEY,
    phase        TEXT NOT NULL CHECK(phase IN ('phase1','phase2')),
    batch_id     TEXT NOT NULL UNIQUE,        -- e.g. 'phase1_b001'
    item_count   INTEGER NOT NULL,
    batch_file   TEXT NOT NULL,
    results_file TEXT,
    extracted_at TEXT NOT NULL,
    ingested_at  TEXT,
    notes        TEXT
);

-- ============================================================================
-- Senders explicitly classified as zero-value (filtered before scoring).
-- ============================================================================

CREATE TABLE IF NOT EXISTS zero_value_senders (
    sender_addr   TEXT PRIMARY KEY,
    reason        TEXT NOT NULL,
    classified_at TEXT NOT NULL,
    classified_by TEXT NOT NULL DEFAULT 'manual'
);

-- ============================================================================
-- Legacy per-message classifications table. APPEND-ONLY.
-- Re-classification produces a new row; prior rows preserved for audit.
-- Current classification = row with MAX(classified_at).
-- (Distinct from message_classifications above; this is the original phased
-- table from the initial migration. New work goes through message_classifications.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS classifications (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id         INTEGER NOT NULL REFERENCES messages(id),
    cluster_id         INTEGER NOT NULL REFERENCES cluster_definitions(cluster_id),
    owner_role         TEXT CHECK(owner_role IN ('sender','to','cc','none')),
    confidence         TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
    reason             TEXT,
    classifier_version TEXT NOT NULL,
    classified_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_classif_msg     ON classifications(message_id);
CREATE INDEX IF NOT EXISTS idx_classif_cluster ON classifications(cluster_id);
CREATE INDEX IF NOT EXISTS idx_classif_msg_at  ON classifications(message_id, classified_at DESC);

-- ============================================================================
-- Disposition log. APPEND-ONLY.
-- Free-form disposition string (the destination folder's displayName, e.g.
-- 'Pending', 'Waiting', 'Complete', 'Later', or NULL = unset / back to inbox).
-- Current disposition per message = row with MAX(set_at).
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages_status (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id       INTEGER NOT NULL REFERENCES messages(id),
    disposition      TEXT,
    set_at           TEXT NOT NULL,
    set_by           TEXT,
    source_path      TEXT,
    ingester_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_msgstatus_msg ON messages_status(message_id, set_at DESC);

-- ============================================================================
-- Per-person engagement counts.
-- Bootstrapped at migration time from messages + recipients + contact_email_map.
-- Maintained incrementally by the classifier sidecar on each owner-send.
-- ============================================================================

CREATE TABLE IF NOT EXISTS engagement (
    contact_entity_id INTEGER PRIMARY KEY REFERENCES contact_entities(id),
    send_count        INTEGER NOT NULL DEFAULT 0,
    last_sent_at      TEXT,
    computed_at       TEXT NOT NULL,
    source            TEXT
);

CREATE INDEX IF NOT EXISTS idx_engagement_count ON engagement(send_count DESC);

-- ============================================================================
-- content_scores. APPEND-ONLY.
-- LLM importance score (0.0–1.0) + optional TLDR for fall-through-cluster
-- messages (newsletters / transactional / cold inbound). Re-scoring inserts
-- a new row; current = MAX(scored_at).
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

-- ============================================================================
-- message_ratings. APPEND-ONLY.
-- One row per Ctrl+Cmd+0..9 keystroke from the Mailspring plugin.
-- Re-tagging inserts a new row; current rating = row with MAX(rated_at).
-- The note column is in-place updateable via Ctrl+Cmd+N.
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_ratings (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id             INTEGER NOT NULL REFERENCES messages(id),
    rating                 INTEGER NOT NULL CHECK(rating >= 0 AND rating <= 9),
    note                   TEXT,
    rated_at               TEXT NOT NULL,
    system_rating_at_time  INTEGER,
    system_cluster_at_time INTEGER,
    source                 TEXT NOT NULL DEFAULT 'plugin-keystroke',
    plugin_version         TEXT,
    sidecar_version        TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_ratings_message
    ON message_ratings(message_id, rated_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_ratings_recent
    ON message_ratings(rated_at DESC);
