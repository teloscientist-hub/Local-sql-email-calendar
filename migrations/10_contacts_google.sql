-- 10_contacts_google.sql
-- Adds tables for syncing Google Contacts into the warehouse and merging
-- them with the message-derived contact_entities created in 00.
--
-- - contacts_google: one row per Google contact resource (people/c...).
-- - contact_addresses, contact_phones, contact_groups: child tables.
-- - contact_merges: audit log of dedup decisions.
-- - contacts_sync_state: singleton row tracking incremental-sync token.
--
-- Depends on 00_warehouse_schema.sql (contact_entities).

CREATE TABLE IF NOT EXISTS contacts_google (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_entity_id     INTEGER NOT NULL REFERENCES contact_entities(id),
    google_resource_name  TEXT NOT NULL UNIQUE,  -- "people/c12345678"
    google_etag           TEXT,
    given_name            TEXT,
    family_name           TEXT,
    middle_name           TEXT,
    name_prefix           TEXT,
    name_suffix           TEXT,
    nickname              TEXT,
    display_name          TEXT NOT NULL,
    organization          TEXT,
    title                 TEXT,
    department            TEXT,
    birthday_iso          TEXT,   -- "2000-03-15" or partial "----03-15"
    notes                 TEXT,
    starred               INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0,1)),
    photo_url             TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    tombstone             INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_contacts_google_entity
    ON contacts_google(contact_entity_id);

CREATE TABLE IF NOT EXISTS contact_addresses (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_entity_id INTEGER NOT NULL REFERENCES contact_entities(id),
    label             TEXT,   -- 'home', 'work', 'other'
    street            TEXT,
    city              TEXT,
    region            TEXT,
    postal_code       TEXT,
    country           TEXT,
    formatted         TEXT,   -- full formatted string from Google
    tombstone         INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_contact_addresses_entity
    ON contact_addresses(contact_entity_id);

CREATE TABLE IF NOT EXISTS contact_phones (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_entity_id INTEGER NOT NULL REFERENCES contact_entities(id),
    phone_normalized  TEXT NOT NULL,  -- digits only
    phone_display     TEXT,
    label             TEXT,           -- 'mobile', 'home', 'work', 'other'
    primary_flag      INTEGER NOT NULL DEFAULT 0 CHECK(primary_flag IN (0,1)),
    tombstone         INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1)),
    UNIQUE(contact_entity_id, phone_normalized)
);
CREATE INDEX IF NOT EXISTS idx_contact_phones_entity
    ON contact_phones(contact_entity_id);

CREATE TABLE IF NOT EXISTS contact_groups (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_entity_id     INTEGER NOT NULL REFERENCES contact_entities(id),
    group_name            TEXT NOT NULL,    -- human label e.g. "Friends"
    google_group_resource TEXT,             -- "contactGroups/abc123"
    tombstone             INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1)),
    UNIQUE(contact_entity_id, group_name)
);
CREATE INDEX IF NOT EXISTS idx_contact_groups_entity
    ON contact_groups(contact_entity_id);
CREATE INDEX IF NOT EXISTS idx_contact_groups_name
    ON contact_groups(group_name);

CREATE TABLE IF NOT EXISTS contact_merges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    winner_id  INTEGER NOT NULL REFERENCES contact_entities(id),
    loser_id   INTEGER NOT NULL REFERENCES contact_entities(id),
    reason     TEXT,
    merged_at  TEXT NOT NULL DEFAULT (datetime('now')),
    merged_by  TEXT NOT NULL DEFAULT 'contacts_intake'
);

CREATE TABLE IF NOT EXISTS contacts_sync_state (
    id             INTEGER PRIMARY KEY CHECK(id = 1),
    sync_token     TEXT,
    last_synced_at TEXT,
    contact_count  INTEGER
);
