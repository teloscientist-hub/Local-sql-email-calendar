# Schema evolution history

The canonical schema in [`00_warehouse_schema.sql`](00_warehouse_schema.sql) is what you run on a fresh install. This file documents the *journey* — the sequence of phased schema changes that produced that end-state, so you understand the **why** behind each table's shape.

If you're building a fresh warehouse, you don't need to run any of these migrations — they're already baked into `00_warehouse_schema.sql`. They are documented here for two reasons:

1. So adopters can see the order in which features were added, which mirrors the order they should be built.
2. As reusable patterns (atomic CHECK-add-via-table-swap, idempotent ALTER, etc.) you may want to apply later when extending your own warehouse.

---

## Phase 0 — initial migration (foundations)

**What:** Migrated the original mail-archive DB into the warehouse shape.

**Tables created:**
- `pst_sources`, `folders`, `messages`, `recipients` (bronze)
- `contact_entities`, `contact_email_map` (person model)
- `me_addresses` (your sending addresses)
- `cluster_definitions`, `classifications` (taxonomy + per-message classification)
- `messages_status` (3-value disposition: complete | pending | cleared)
- `engagement` (per-person send count)

**Key invariants introduced:**
- `contact_email_map.email` has `CHECK(email = LOWER(email))` — emails always lowercased.
- Append-only on `classifications` (re-classify = insert new row).
- Tombstone columns on tables that support soft-delete (never hard-delete).

**Pattern of note — adding a CHECK to an existing column:**
SQLite cannot `ALTER TABLE ADD CHECK`. To add one, recreate the table with the constraint, copy data with the constraint applied (`SELECT LOWER(email) ...`), drop the old, rename the new. Run inside one transaction with `PRAGMA foreign_keys = OFF` so the swap doesn't break FKs.

**Bootstrap step — `me_addresses` candidates:** the migration auto-populates `me_addresses` with email addresses where the sender display name suggests "you" (this is heuristic, intentionally noisy, and **must be reviewed by hand** before the engagement bootstrap runs). Flag the reviewed rows by clearing the `notes='CANDIDATE — review before engagement bootstrap'` value.

---

## Phase 0.5 — engagement bootstrap

**What:** Computed per-person send counts from `messages` + `recipients` + `contact_email_map`.

**Tables affected:** `engagement` (populated for the first time), `contact_entities` + `contact_email_map` (auto-create rows for any recipient address not yet mapped to a person).

**Preconditions:**
1. `me_addresses` has been reviewed by you and contains your real sending addresses (no rows still tagged `CANDIDATE`).
2. Working on a copy of the DB. Never the original.

**Logic:** for each message where `LOWER(sender_addr) ∈ me_addresses`, credit +1 to the `contact_entity_id` of each `to`/`cc` recipient. List addresses get +1 only — list membership is not expanded.

**Defensive abort pattern:** the script tries to `INSERT NULL INTO engagement.contact_entity_id` (which is the PK and NOT NULL) when a precondition is violated. The NULL violation aborts the transaction. The `SELECT` only returns a row when the precondition fails, so the assertion is a no-op in the happy path.

---

## Phase 0.5b — disposition vocabulary (free-form)

**What:** Reframed the "done state" model from a fixed enum (`complete | pending | cleared`) to a free-form string mirroring the destination folder name (`Pending`, `Waiting`, `Complete`, `Later`, ...). The plugin moves threads into named folders; the warehouse mirrors the folder name.

**Schema change:** `messages_status.status` (TEXT with CHECK) → `messages_status.disposition` (TEXT, no CHECK).

**Mapping applied during the swap:**
- `'pending'`  → `'Pending'`
- `'complete'` → `'Complete'` *(Gmail reserves `Done` as a system label, so we use `Complete` everywhere for cross-provider consistency)*
- `'cleared'`  → `NULL` *(cleared meant "back to inbox / unset")*

**Pattern of note — column-rename + constraint-drop in one swap:** create new table with the new shape, `INSERT ... SELECT CASE old_col WHEN ... THEN ... END AS new_col`, drop old, rename new. SQLite can't rename or drop CHECK constraints in place.

---

## Phase 2 — content_scores

**What:** Added LLM-driven importance scoring (0.0–1.0) for fall-through-cluster messages — newsletters (cluster 29), transactional (30), cold inbound (31). For these, the sidecar runs the LLM on the body and writes a row.

**Table created:** `content_scores` (append-only).

**Why a separate table:** distinct from cluster classification, which lives in `classifications`. Score and classification are orthogonal — a newsletter (cluster 29) might score 0.05 (definitely skip) or 0.85 (worth surfacing).

**TLDR rule:** `tldr_text` is `NULL` when importance is below the show-threshold (default 0.6). Don't waste tokens on TLDRs you won't display.

---

## Phase 2.5 — message_ratings (manual override)

**What:** Added a 0–9 keystroke set (`Ctrl+Cmd+0..9`) in the Mailspring plugin. Each tap writes one row to `message_ratings`.

**Table created:** `message_ratings` (append-only).

**Rules:**
- `rating ∈ {0..9}` enforced by CHECK. `0` is a deliberate "explicit zero-value" signal, distinct from null/missing.
- The optional `note` column carries the WHY ("this is a promo blast, not a personal email"). When present, the tag is treated as **context-conditional** — it suppresses the per-contact CSV update (the sender's baseline rating is *not* reset) and instead joins the rule-mining corpus for future automated rule generation.
- `system_rating_at_time` and `system_cluster_at_time` snapshot what the system showed *you* at the moment of the keystroke. Disagreement (`rating != system_rating_at_time`) is the active-learning signal.

---

## Phase 3 (no schema change, plugin-only)

The 3-layer badge, TLDR overlay, and disposition keystrokes all use the existing schema. No migration.

---

## Phase 4 — Mailspring intake

**What:** A one-shot CLI that reads new messages from Mailspring's `edgehill.db` and inserts them into the warehouse. No schema change — it writes to existing `messages`, `recipients`, `contact_entities`, `contact_email_map` tables.

**Pattern of note — bronze→silver ingest under a synthetic source:** a synthetic `pst_sources` row named `mailspring-live-ingest` is the parent for all live-ingested messages. This keeps the FK invariant (`messages.pst_source_id NOT NULL`) intact while distinguishing live mail from PST imports.

---

## Phase 4.5+ (open)

Pending changes captured in [`docs/FUTURE_IMPROVEMENTS.md`](../docs/FUTURE_IMPROVEMENTS.md). Likely candidates that would touch schema:

- **Smart entity dedup** — collapse duplicate `contact_entities` rows that point to the same human (different addresses, same name). Merge tooling needed.
- **Per-rule audit log** — when an auto-rule fires from a `note` tag, record the rule's provenance and the rows it would affect.
- **Continuous live ingest** — a polling daemon (5-minute interval) replacing the current one-shot CLI; needs a `last_ingest_at` watermark table.

---

## Naming notes

The names `me_addresses` / `is_me` / `owner_role` are the per-user concepts: the email addresses you receive mail at, the flag that marks a contact-entity row as "this is you," and the JSON field describing your role in a thread. Earlier internal revisions used author-named equivalents; the template uses these generic names. Feel free to rename them to whatever feels natural for your installation — they're conventional, not load-bearing.

The package name `mml_classifier`, the launchd label `com.mml.classifier`, and the `MML_CLASSIFIER_*` env-var prefix are project-brand and can stay as-is unless you want a stronger fork.
