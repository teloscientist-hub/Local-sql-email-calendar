# Build guide — why the system is built in this order

> A phase-by-phase narrative reconstruction of how the system grew from "empty SQLite file" to "self-refining LLM classifier suite." Each phase delivers user-visible value and depends on the prior one. The current template gives you the finished artifact; this guide explains how it got that way and which dependencies are load-bearing.

For the executable checklist version, read [`SETUP.md`](../SETUP.md). For the cross-cutting architecture, read [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Phase 0 — Warehouse foundations

**Problem:** SQLite is the right substrate (local, transactional, single-file, fast on 100k+ row queries), but there's no shipped schema for email + people + classifications + ratings + LLM suggestions + calendar.

**Solution:** define one source-of-truth schema (`migrations/00_warehouse_schema.sql`) covering messages, recipients, contact_entities, contact_email_map, me_addresses, sender_classifications, message_classifications, cluster_definitions, engagement, message_ratings, content_scores, calendar tables, and zero_value_senders. All later migrations are additive (`CREATE TABLE IF NOT EXISTS …`) so the schema evolves without `DROP`.

**Files added:** `migrations/00_warehouse_schema.sql`, the `me_addresses` seed SQL in `SETUP.md`.

**Data shape after:** an empty warehouse with all tables and indexes present. `me_addresses` has your own sending addresses.

---

## Phase 1 — Historical ingest (optional)

**Problem:** with no history, there's nothing for the cluster classifier or the rating classifier to learn from. Manual rating starts cold.

**Solution:** the `pipeline/` directory reads PST / mbox / Gmail Takeout / IMAP exports and inserts deduplicated rows into `messages` + `recipients`, then walks the addresses to build `contact_entities` (the canonical person record) + `contact_email_map` (email → person).

**Files added:** ingest scripts under `pipeline/`. The artifact this phase produces — `contacts_to_rate.csv` — is your starting rating CSV, ranked by historical interaction count.

**Data shape after:** `messages`, `recipients`, `contact_entities`, `contact_email_map`, `engagement` populated. `contacts_to_rate.csv` lists your top correspondents at the top, mostly unrated.

---

## Phase 2 — Per-sender + per-message classification (deferred to runtime)

**Problem:** every message wants a cluster label, but cluster labels are personal — what counts as "longtime friends" varies by user. Classifying every message manually is impossible; classifying every message at every model bump is wasteful.

**Solution:** two-tier classification:
- **Phase 2 (Phase 4.5 in runtime form, see below)** — per-sender classification (cheaper, one LLM call per unique sender, stored in `sender_classifications`).
- **Per-message override** for senders whose cluster varies by content (`message_classifications`), filled in real-time as new mail arrives.

This template ships the real-time per-message path (`cluster_classifier.py`) and a generator (`tools/taxonomy_generator.py`) for the cluster taxonomy itself. You don't run a giant batch backfill — clusters emerge as mail arrives.

**Files added:** `services/mml-classifier/mml_classifier/cluster_classifier.py`, the prompt at `prompts/cluster_classify_v1.md`, the taxonomy meta-prompt at `prompts/taxonomy_meta_v1.md`, the CLI at `tools/taxonomy_generator.py`.

---

## Phase 2.5 — Per-message rating overrides

**Problem:** the CSV gives one rating per sender, but real life has exceptions (the same friend sending a transactional newsletter you don't want elevated). The system needs a per-message override mechanism.

**Solution:** the `message_ratings` table (one row per `Ctrl+Option+<digit>` keystroke), append-only, with `note` column for free-text WHY. `ratings.effective_rating_decision()` checks `message_ratings` first (tier 0), then the CSV (tier 1), then cluster default, then zero.

**Files added:** `migrations/02_message_ratings.sql`, `services/mml-classifier/mml_classifier/ratings.py` `effective_rating_decision()`, plugin `tag-keystroke-handler.js` + `note-keystroke-handler.js`.

---

## Phase 3 — Mailspring plugin (badge, TLDR, dispositions)

**Problem:** the warehouse has ratings + classifications, but Mailspring doesn't know. The user can't actually *see* anything yet.

**Solution:** a Mailspring plugin (`plugin/`) that:
- Registers `EngagementBadge` at `ComponentRegistry` role `ThreadListIcon` (the leftmost icon slot on each thread row). The badge fetches `/thread` from the localhost sidecar and renders one of: PersonBand (manual/CSV/family rating), CategoryTag (cluster), or ContentMarker (TLDR-eligible newsletter).
- Registers a TLDR overlay above message bodies.
- Registers `Cmd+Shift+1..4` disposition keystrokes that move threads to top-level `Pending/Waiting/Complete/Later` folders.

**Hard parts discovered the hard way:**
- `react-dom` is NOT in the plugin sandbox. Overlays must use vanilla DOM.
- `AppEnv.keymaps.add` doesn't exist — use `AppEnv.commands.add` and let `keymaps/*.json` bind names.
- The ThreadListIcon slot is sized for tiny dots (~16px); CSS `min-width: 36px` + `overflow: visible` on parent containers is mandatory or the badge clips.

**Files added:** everything under `plugin/src/` and `plugin/keymaps/`. `package.json`, `tsconfig.json`.

---

## Phase 4 — Live intake from Mailspring

**Problem:** new mail arriving in Mailspring doesn't enter the warehouse unless something tells it to. Without that, badges only show for historical mail.

**Solution:** `mailspring_intake.py` reads Mailspring's `edgehill.db` (Mailspring's local mail cache, SQLite), dedups against the warehouse by RFC-822 Message-ID, and inserts new rows. Supports `--since`, `--limit`, `--commit` (dry-run by default), and auto-creates an APFS-clone warehouse backup before each write.

**Files added:** `services/mml-classifier/mml_classifier/mailspring_intake.py`.

---

## Phase 4.5 — Real-time cluster classification

**Problem:** newly-ingested messages have no cluster until a Phase-2 backfill runs. A daily-scheduled batch is too slow; users want the cluster tag on the thread row immediately.

**Solution:** a background daemon thread in the sidecar (`cluster-worker`) consumes a queue. Every `mailspring_intake` commit fans out the new `message_id`s onto the queue; the worker LLM-classifies each in seconds. Output goes to `message_classifications` tagged with `classifier_version` (e.g. `cluster_classify_v1@haiku`).

**Critical pattern:** **version-tagged classifications** are the cache-invalidation primitive. Bumping the version makes old rows invisible to the new version's reads without `DELETE`. The system can fork its taxonomy and keep both versions queryable in parallel.

**Files added:** `cluster_classifier.py`, `prompts/cluster_classify_v1.md`. The cluster taxonomy doc itself (`email_classification_instructions_universal.md`) lives at the repo root — the user generates it via Phase 3 of [`SETUP.md`](../SETUP.md).

---

## Phase 5 — Google Calendar integration

**Problem:** the system knows about email; it doesn't know about meetings. Email-to-meeting workflows ("schedule a follow-up on this thread") need glue.

**Solution:** Google Calendar OAuth (one-time desktop-app consent flow → token refresh handled inside the sidecar), `calendar_intake.py` for historical ingest, and an inline event-drafter triggered by `Ctrl+Option+E` on a focused thread. The drafter reads the email, calls Claude with `draft_event_v1.md` (filling title/description/start/duration/attendees), and pops a small overlay; submit creates the event in Google Calendar via the same OAuth.

**Files added:** `gcal_oauth_setup.py`, `gcal_oauth.py`, `gcal_client.py`, `event_drafter.py`, `event_creator.py`, `calendar_normalize.py`, `calendar_history.py`, `calendar_intake.py`. Migrations `04_calendar.sql` + `05_calendar_active_view.sql`. Plugin `event-keystroke-handler.js` + `event-input-overlay.jsx`.

---

## Phase 5.5 — Unified sidebar + routing keystrokes

**Problem 1:** when the user has multiple accounts (e.g. Gmail + IMAP), each account's `Routed/<name>` folders appear in a separate section of Mailspring's sidebar. To see "everything in `Routed/fun`" the user needs two clicks (one per account).

**Solution 1:** monkey-patch Mailspring's internal `SidebarSection.standardSectionForAccounts` to inject two unified parents (`Processing`, `Routed`) into the All-Accounts section. Children-by-name aggregation across accounts. Source: `sidebar-extension.js`.

**Problem 2:** routing requires keystrokes. `Cmd+Shift+1..4` was used for dispositions; that's only 4. The user has 8+ routing folders.

**Solution 2:** `Cmd+Option+<letter>` mapping per folder. Each press logs a `routing_corrections` row with source `manual` / `accept` / `override`. `Cmd+Option+Y` triggers an LLM routing suggestion overlay (fetches `/route-suggest`, lets the user accept or override).

**Hard parts:**
- `Cmd+Option+D` collides with macOS Show/Hide Dock — use a different letter.
- `Option+<digit>` alone produces typographic chars (`Option+1` = ¡); routing must use letters with `Cmd+Option`.
- Dictation tools that capture Control globally (Wispr Flow and similar) eat bare `Ctrl` chords; either reconfigure the dictation tool or avoid bare Ctrl in any keymap.

**Files added:** plugin `routed-keystroke-handler.js`, `accept-suggestion-handler.js`, `route-confirm-overlay.jsx`. Sidecar `route_classifier.py`. Migration `06_routing.sql` (routing_suggestions + routing_corrections).

---

## Phase 5.5.3 — Auto-intake

**Problem:** the user has to remember to run `python -m mml_classifier.mailspring_intake --commit` to see badges on new mail.

**Solution:** the plugin subscribes to `DatabaseStore.listen()`, debounces 5 s, and POSTs `/intake-now` to the sidecar. The sidecar single-flights via a lock and fans out to all three classifier queues (cluster + routing + rating).

**Files added:** plugin `auto-intake.js`, sidecar `/intake-now` HTTP handler.

---

## Phase 5.5.5 — Self-refining routing prompt

**Problem:** the routing prompt is hand-written. Every override the user makes is signal that the prompt is wrong somewhere — but no one is reading those overrides and updating the prompt.

**Solution:** after every 25 net-new `routing_corrections` rows, the sidecar fires `prompt_refinement.refine()`. Claude Sonnet reads the current prompt + the last 200 corrections and proposes either (a) new anchor lines for the "Known signals" section, or (b) byte-for-byte phrase replacements within folder definitions. The applier validates the constraints (no schema/keymap touches, replacement phrase must match the source exactly) and writes a new version file. `CURRENT_VERSION.txt` updates atomically.

**Rollback:** `python -m mml_classifier.prompt_refinement --rollback` rewrites `CURRENT_VERSION.txt` to the parent version. The old version's classifications stay queryable because they're tagged with the prior `classifier_version`.

See [`docs/PROMPT_REFINEMENT.md`](PROMPT_REFINEMENT.md) for the full loop.

**Files added:** `prompt_refinement.py`, `prompts/refinement_meta_v1.md`, migration `07_prompt_versions.sql` (audit table), `prompts/CURRENT_VERSION.txt`.

---

## Phase 5.5.6 — Unified Processing parent

**Problem:** the disposition folders (`Pending/Waiting/Complete/Later`) live at the top level of each account; cross-account visibility is the same multi-click problem the routing sidebar fix solved.

**Solution:** extend the Phase 5.5 monkey-patch to inject a `Processing` parent above `Routed`, listing the same four disposition folders aggregated across accounts.

**Files touched:** `sidebar-extension.js` (one additional injection, same pattern as `Routed`).

---

## Phase 6.0 — LLM rating suggester

**Problem:** the rating classifier was the missing third leg of the LLM stool. Routing and clustering were already real-time; ratings were entirely manual.

**Solution:** `rating_classifier.py` produces a 0–9 suggestion per message, stored in `rating_suggestions` (append-only). Embeds the owner's last ~50 `message_ratings` (including any `note`) as ground-truth few-shot — the LLM learns from the user's own decisions.

**Files added:** `rating_classifier.py`, `prompts/rating_suggest_v1.md`, migration `08_rating_suggestions.sql`.

---

## Phase 6.0.f — Rating-suggestion visual chip

**Problem:** the user has no visibility into what the rating classifier predicted, so `Ctrl+Option+<digit>` keystrokes carry no implicit accept/override signal.

**Solution:** render the LLM's suggested rating as a hex-shaped chip in the badge (shape differs from the round PersonBand pill so the user can tell "guess" vs "decision"). Now every digit keystroke implicitly accepts or overrides a visible prediction — exactly the same pattern as the routing accept/override loop.

**Files added/modified:** plugin `rating-suggestion-chip.jsx`, `rating-colors.js` (shared palette), `engagement-badge.jsx` (dispatch order update).

---

## Phase 7 — Template extraction (this repo)

**Problem:** the working system is hard-coded to one user's data, paths, and taxonomy. Sharing it as a method (not as data) means extracting a clean public template.

**Solution:** this repo. Anonymized sidecar + plugin + migrations + docs + taxonomy-generator. Personal-data files are template skeletons (`templates/*.template.*`) the user fills in. Cluster taxonomy is per-deployment via the generator. Routing folder names mirror the working system as a worked example with explicit "edit these" guidance.

**Files added:** the entire repo. Maintained as a fork-and-customize starting point.

---

## Open work — Phase 8+

See [`docs/FUTURE_IMPROVEMENTS.md`](FUTURE_IMPROVEMENTS.md). High-leverage next steps:

- **Continuous live ingest** — the auto-intake hook covers new mail; replace the periodic manual `python -m mml_classifier.mailspring_intake --commit` with a polling daemon that captures unsubscribe states / folder moves on the Mailspring side.
- **Smart entity dedup** — the initial pipeline creates a fresh `contact_entity` for every unknown address; humans appearing under multiple addresses get split records. Build a merge tool.
- **Rule-mining from notes** — `message_ratings.note` carries the WHY of ratings. Mine the corpus to discover sender→cluster patterns worth promoting to Mailspring mail rules (the Phase 5.5.4 `promote_corrections.py` does this for routing; same idea for ratings).
- **Tailscale exposure** — currently localhost-only. To triage from another device, expose the sidecar via Tailscale.
- **Litestream backup** — continuous SQLite backup to S3 / similar; the warehouse is your only durable artifact.
- **Graph projection** — port the silver layer into Neo4j+Graphiti for relationship queries that don't fit in SQL.

---

## Tips

- **Build vertically, not horizontally.** Get *something* end-to-end working before adding features. A plugin that shows one ugly badge for one sender is more useful than a perfectly-classified warehouse no UI can see.
- **`contacts_to_rate.csv` is your source of truth.** The warehouse mirrors it. When the two disagree, the CSV wins (you can re-derive the warehouse).
- **Backup the warehouse before any bulk write.** `cp -c warehouse.sqlite warehouse.sqlite.pre-<thing>-<ISO>`. APFS clones cost nothing.
- **Trust the badge before trusting the sort.** Date-ordered inbox + colored badges is a stable workflow. Auto-sort by engagement requires a Mailspring fork — defer it.
- **Append-only writes; latest-by-id reads.** This pattern keeps your data audit-friendly and makes `classifier_version` the cache-invalidation primitive.
