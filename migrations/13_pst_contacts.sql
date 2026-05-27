-- 13_pst_contacts.sql
-- Provenance / non-duplicative metadata for contacts imported from Outlook PST
-- contact archives (e.g. "contacts.pst").
-- Safe to run multiple times (CREATE IF NOT EXISTS).
--
-- Phones, postal addresses, and group memberships from the PST reuse the
-- existing contact_phones / contact_addresses / contact_groups tables (additive).
-- This table is the home for the fields that have no non-Google equivalent
-- (organization / title / web page / file-as) plus per-PST provenance.
--
-- New table:
--   pst_contact_meta — one row per (contact_entity, source_pst)

-- ============================================================================
-- pst_item_key is a deterministic fingerprint of the PST card (file_as,
-- name, emails, phones). UNIQUE(source_pst, pst_item_key) is the idempotency
-- key: re-running the importer claims the same contact_entity instead of
-- creating duplicates (the name-only path is otherwise non-idempotent).
CREATE TABLE IF NOT EXISTS pst_contact_meta (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_entity_id INTEGER NOT NULL REFERENCES contact_entities(id),
    source_pst        TEXT NOT NULL,          -- e.g. 'contacts.pst'
    pst_item_key      TEXT NOT NULL,          -- sha1 fingerprint of the card
    file_as           TEXT,                   -- PST Subject, "Last, First"
    organization      TEXT,
    title             TEXT,
    web_page          TEXT,
    source_folder     TEXT,                   -- PST folder the contact lived in
    imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
    ingester_version  TEXT,
    tombstone         INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1)),
    UNIQUE(source_pst, pst_item_key)
);

CREATE INDEX IF NOT EXISTS idx_pst_contact_meta_entity
    ON pst_contact_meta(contact_entity_id);
