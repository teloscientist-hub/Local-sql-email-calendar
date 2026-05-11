# MML Productivity — Architecture Onboarding

> Read this end-to-end before touching code in the repo. ~20-minute read. After this you should be able to navigate the codebase, understand what each component does, and reason about where a new feature should live.

## The 30-second pitch

The owner runs their email through Mailspring. The MML Productivity system reads Mailspring's local mail cache, classifies and rates every conversation along three orthogonal axes (per-deployment cluster taxonomy, 0–9 relationship rating, 1-of-N routing folder), paints a small visual badge on every inbox row, and provides keystroke shortcuts so the owner can triage by relationship importance rather than by date. Phase 5 added Google Calendar to the same warehouse (Ctrl+Option+E drafts+creates events from email; a separate intake CLI pulls all calendar history). Phases 5.5 and 6.0 added three real-time LLM classifiers running in parallel inside the sidecar, plus a unified sidebar that aggregates same-named folders across both connected accounts, plus a self-refining prompt loop that distills user corrections into prompt edits without human supervision. Phase 6.0.f surfaces the rating LLM's guess as a hex chip in the badge, so every Ctrl+Option+digit becomes an implicit accept/override against a visible prediction. The whole pipeline is **local-first** — no cloud services, no external SaaS — running on the owner's local machine.

There are six moving parts. They communicate via SQLite (one shared warehouse) and HTTP (a localhost sidecar). The pipeline is bronze → silver → gold:

- **Bronze** — Mailspring's `edgehill.db` (mail cache), the original PST imports, and the Google Calendar API. Raw, never modified by us.
- **Silver** — `warehouse.sqlite` (~320k messages as of 2026-05-11). Our normalized truth source. All schemas, all ratings, all classifications, all calendar events, and all LLM suggestions live here.
- **Gold** (deferred) — Neo4j+Graphiti projection of the silver layer. Not built yet.

## System at a glance

```
                                        ┌───────────────────────────────────┐
                                        │  Mailspring (Electron app)        │
                                        │   ~/Library/.../edgehill.db       │  ← bronze, read-only to us
                                        │   /Applications/Mailspring.app    │
                                        │                                   │
                                        │   ┌─────────────────────────────┐ │
                                        │   │ MML plugin (JS/JSX)         │ │  ← plugin/
                                        │   │  - badge in thread list     │ │
                                        │   │  - tag keystrokes ⌃⌥0..9    │ │
                                        │   │  - note keystroke ⌃⌥N       │ │
                                        │   │  - event keystroke ⌃⌥E      │ │
                                        │   │  - disposition ⇧⌘1..4       │ │
                                        │   │  - route ⌘⌥A/B/C/E/F/H/M/   │ │
│   │    P/S/W/X (11 folders)     │ │
                                        │   │  - accept-suggestion ⌘⌥Y    │ │
                                        │   │  - unified sidebar parents  │ │
                                        │   │    (Processing, Routed)     │ │
                                        │   │  - auto-intake on DB events │ │
                                        │   │  - OwnerAddr column          │ │
                                        │   └────────┬────────────────────┘ │
                                        └────────────┼──────────────────────┘
                                                     │
                                                     │  HTTP localhost:8765
                                                     ▼
   ┌──────────────────────────┐         ┌───────────────────────────────────────────┐
   │ warehouse.sqlite         │ ◀──read─│  mml-classifier sidecar (Python)          │ ← services/mml-classifier/
   │  (silver, source-of-     │ ──write─│   GET  /thread, /healthz                  │
   │   truth)                 │         │   POST /rate-message, /add-note           │
   │                          │         │   POST /score-now, /draft-event,          │
   │  Email & people:         │         │        /create-event                      │
   │  - messages              │         │   POST /route-suggest, /route-correction  │
   │  - recipients            │         │   POST /rating-suggest                    │
   │  - contact_entities      │         │   POST /intake-now                        │
   │  - contact_email_map     │         │                                           │
   │  - me_addresses        │         │   Background daemon threads:              │
   │  - sender_classifications│         │     · routing-worker  (LLM, queued)       │
   │  - message_classifications│        │     · cluster-worker  (LLM, queued)       │
   │  - content_scores         │        │     · rating-worker   (LLM, queued)       │
   │  - message_ratings        │        │                                           │
   │  - engagement             │        │   launchd: com.mml.classifier             │
   │                           │        │   logs:    ~/Library/Logs/mml-classifier/ │
   │  LLM suggestions:         │        └──────────┬────────────────────────────────┘
   │  - routing_suggestions    │                   │
   │  - routing_corrections    │                   │  reads (one-shot, idempotent)
   │  - routing_prompt_versions│                   ▼
   │  - rating_suggestions     │   ┌──────────────────────────────────────┐
   │                           │   │ Mailspring intake (Python)           │ ← mml_classifier/mailspring_intake.py
   │  Calendar:                │   │  CLI:  --commit / --since / --limit  │
   │  - calendars              │   │  HTTP: /intake-now (plugin-triggered)│
   │  - events                 │   │  Reads edgehill.db, dedups by RFC-ID,│
   │  - event_attendees        │   │  inserts messages+recipients, fans   │
   │  - event_changes          │   │  out to the 3 classifier queues.     │
   │  - events_active (view)   │   └──────────────────────────────────────┘
   └──────────▲────────────────┘
              │
              │ reads (sender→rating lookup)
              │
   ┌──────────┴────────────────┐
   │ contacts_to_rate.csv      │ ← The owner's hand-curated person ratings (1–9, blank=unrated)
   │  (the user-facing surface │   contacts_to_rate.csv
   │   The owner edits by hand)     │
   └───────────────────────────┘
```

## The major components

### 1. Warehouse — `warehouse.sqlite`

The single source of truth. SQLite, ~600 MB+. Schema is grouped into three concerns: mail + people, LLM suggestions (Phase 5.5/6.0), and calendar.

**Email and people:**

| Table | Rows (2026-05-11) | What it holds |
|---|---:|---|
| `messages` | ~320,400 | One row per email. `message_id` = RFC-822 Message-ID. Every other table FKs back to here. |
| `recipients` | 375,659 | Per-message To/CC/BCC, one row per (message, kind, addr). |
| `contact_entities` | 18,822 | Person records. Primary key for engagement, ratings, AND calendar attendees. |
| `contact_email_map` | 21,023 | Email → person. Many emails can resolve to the same person. CHECK lower-case. |
| `me_addresses` | 47 | Email addresses that count as "owner sending." |
| `pst_sources` | 8 | Provenance: 7 PST imports + 1 synthetic `mailspring-live-ingest` row. |
| `folders` | 258 | Folder hierarchy per source. Mailspring intake adds a flat handful. |
| `sender_classifications` | ~370 | Per-sender (sender_addr) cluster + `priority_friend` flag. From Phase 1 agent + manual review. |
| `message_classifications` | growing | Per-message cluster assignment. Grows in real-time via the Phase 4.5 cluster-worker on every new message. |
| `content_scores` | (Phase 2 cohort) | Per-message LLM importance + tldr_text. Append-only; latest wins. |
| `message_ratings` | (built up by ⌃⌥0..9) | Manual 0–9 ratings per message, append-only; `note` column is in-place updateable. |
| `engagement` | 5,058 | Per-person send counts + last_sent_at. Bootstrapped at migration time. |

**LLM-suggestion side (Phase 5.5 + 6.0):**

| Table | Purpose |
|---|---|
| `routing_suggestions` | Append-only LLM-routed-folder suggestions (1-of-11). `(message_id, classifier_version, scored_at)`. |
| `routing_corrections` | Append-only record of every accept/override/manual decision the owner made on a route. Drives self-refinement. |
| `routing_prompt_versions` | Audit trail of self-refinement runs. One row per refinement (auto or manual), with `parent_version`, the JSON proposal, the model used, and whether it deployed. |
| `rating_suggestions` | Append-only LLM-suggested 0–9 ratings. `(message_id, classifier_version, scored_at)`. |

**Calendar (Phase 5):**

| Table | Rows (2026-05-10) | What it holds |
|---|---:|---|
| `calendars` | 0 (until OAuth setup) | One row per (Google account, calendar). Has `sync_token`, `is_default`, `is_primary`. |
| `events` | 0 (until ingest) | One row per (calendar, gcal_event_id). Unified table for `source='plugin-create'` AND `source='gcal-sync'`. |
| `event_attendees` | 0 | Normalized attendees. Email joins `contact_email_map` → `contact_entities`. |
| `event_changes` | 0 | Append-only event history. `change_kind` ∈ {`plugin-create`, `insert`, `update`, `cancel`, `delete`}. Full Google payload preserved as `snapshot_json`. |
| `events_active` (view) | 9,045 of 56,905 (2026-05-10) | **Recommended query surface.** Sliding-window view filtered to `[now-5y, now+1y)`. |

**Schema lives at:** `warehouse_schema.sql` (canonical) and `migrations/*.sql` (migrations).

**Key invariants:**
- `messages.message_id` = RFC-822 Message-ID. The plugin sends these; the sidecar resolves to PKs.
- `messages.pst_source_id` is `NOT NULL` — every message has a source. Mailspring-ingested rows point to the synthetic `mailspring-live-ingest` row.
- All emails are lowercased on insert. `contact_email_map.email` and `me_addresses.email` have `CHECK(email = LOWER(email))`.
- Append-only on `message_ratings.rating`, `content_scores.importance_score`, `routing_suggestions.*`, `rating_suggestions.*`. Re-classification creates a NEW row; latest at the current `classifier_version` wins.
- `message_classifications.message_id` is `UNIQUE` — only one cluster per message. Cluster reclassification requires `--force` (DELETE-then-INSERT).
- `message_ratings.note` is the ONLY in-place updateable cosmetic column. Everything else is append-only.

### 2. Sidecar — `services/mml-classifier/`

Python HTTP daemon, stdlib `http.server` (no FastAPI, no aiohttp). Listens on `127.0.0.1:8765`. Autostarts via `launchd` (plist at `services/mml-classifier/launchd/com.mml.classifier.plist` symlinked from `~/Library/LaunchAgents/`).

**Endpoints (all return 200 OK with nullable fields rather than 4xx; plugin treats sidecar-down as silent fail):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Returns version, `last_score_at`, `claude_cli_ok`, `gcal` (OAuth status). |
| GET | `/thread?ids=<rfc>,<rfc>...` | Returns aggregated `ThreadState` for the given RFC-822 Message-IDs. The plugin's badge renderer is the only consumer. |
| POST | `/score-now` | `{message_ids: [int]}`. Synchronous LLM content scoring. Single-flight. |
| POST | `/rate-message` | `{rfc_message_id?, message_id?, rating, note, what_i_saw_on_screen, plugin_version}`. Records a manual rating row. |
| POST | `/add-note` | `{rfc_message_id?, message_id?, note}`. UPDATEs `note` on the latest `message_ratings` row. |
| POST | `/draft-event` | Phase 5. LLM-drafts a calendar event from the email. Read-only — no GCal call. |
| POST | `/create-event` | Phase 5. Writes to Google Calendar via OAuth and mirrors into `events` + `event_attendees` + `event_changes`. |
| POST | `/intake-now` | Phase 5.5.3. Plugin-triggered. Pulls new Mailspring mail → `messages`, fans out to all three classifier queues. |
| POST | `/route-suggest` | Phase 5.5.2. `{rfc_message_id?, cached_only?}`. Returns the 1-of-11 routing suggestion. With `cached_only:true` (default for plugin), never fires an LLM call — returns cache row or `"not yet classified"`. |
| POST | `/route-correction` | Phase 5.5.2. Records an accept/override/manual decision; also increments the self-refinement trigger counter (5.5.5). |
| POST | `/rating-suggest` | Phase 6.0. `{rfc_message_id?, cached_only?}`. Returns the LLM's 0–9 suggestion + reason + confidence. |

**ThreadState shape** (returned by `/thread`):

```python
{
    "rating": int | None,            # effective rating (0..9), highest in thread
    "rating_source": str | None,     # 'manual' | 'csv' | 'priority_friend' | 'family' | 'cluster_default' | 'zero'
    "cluster_id": int | None,        # most-recently-classified message's cluster
    "cluster_name": str | None,
    "importance_score": float | None,
    "tldr_text": str | None,
    "reason": str | None,
    "scored_at": str | None,
    "matched_message_count": int,
    "to_me_addr": str | None,      # which owner address this thread was sent to
    # Phase 6.0.f — LLM rating suggestion. Latest by scored_at across the
    # thread's messages, filtered to current RATING_CLASSIFIER_VERSION.
    "suggested_rating": int | None,         # 0..9; plugin treats 0 as no-signal
    "suggestion_confidence": float | None,  # 0.0..1.0
    "suggestion_reason": str | None,
    "suggestion_scored_at": str | None,
}
```

`rating_source` is what gates the PersonBand pill on the plugin side (only `manual`/`csv`/`priority_friend`/`family` render a visible pill; `cluster_default` and `zero` are suppressed regardless of value). When no PersonBand renders, `suggested_rating >= 1` triggers a hex-shaped `RatingSuggestionChip` (Phase 6.0.f) in the same slot, displacing the cluster tag for that row.

**Background workers (Phase 5.5.2 + 4.5 + 6.0):** the sidecar runs three independent daemon threads, each draining its own queue. Producers are `/intake-now` (the main fan-out) plus on-demand HTTP calls. Each worker is a simple `for mid in queue: classify(mid)` loop with try/except so a single failure never kills the worker.

| Worker | Reads | Writes | Prompt |
|---|---|---|---|
| `routing-worker` | message body + sender + subject | `routing_suggestions` | `prompts/route_suggest_v{N}.md` (current via `prompts/CURRENT_VERSION.txt`) |
| `cluster-worker` | message body + sender + subject + recipients | `message_classifications` | `prompts/cluster_classify_v1.md` + `email_classification_instructions_universal.md` (concatenated at runtime) |
| `rating-worker` | message body + sender + subject + cluster_id + priority_friend | `rating_suggestions` | `prompts/rating_suggest_v1.md` + recent `message_ratings` rows as few-shot |

**Version-pointer pattern (Phase 5.5.5).** The current routing-prompt version is read from `prompts/CURRENT_VERSION.txt` (single line, atomically rewritten via temp+rename). Bumping the version invalidates the routing cache lookups (which filter on `classifier_version`). Rollback is a one-line file write. Old prompt files (`route_suggest_v1.md`, `v2.md`, ...) stay on disk for history.

**Key sidecar files:**

- `server.py` — HTTP routing + queue/worker scaffolding. Three `_*_QUEUE`s, three `_*_SEEN` dedup sets, three worker threads spawned in `serve()`. Single-flight locks for `/score-now` and `/intake-now`. The `/route-correction` handler bumps a counter and spawns a one-shot daemon thread to run `prompt_refinement.refine()` when the counter crosses `ROUTING_REFINEMENT_TRIGGER_COUNT` (default 25).
- `thread_lookup.py` — `/thread` aggregation. Big SQL JOIN that fuses messages + classifications + sender_classifications + content_scores + message_ratings + recipients + rating_suggestions into a `ThreadState`. Picks the max-rating row's source as the thread-level `rating_source`; picks the latest-by-`scored_at` row across the thread for `suggested_rating` (filtered to current `RATING_CLASSIFIER_VERSION`, mirrors the cluster aggregation rule).
- `ratings.py` — `effective_rating_decision(sender_addr, cluster_id, priority_friend, manual_message_rating)`. Returns `RatingDecision(rating, source)` where `source: RatingSource` is one of `MANUAL` | `CSV` | `PRIORITY_FRIEND` | `FAMILY` | `CLUSTER_DEFAULT` | `ZERO`. Older `effective_rating_for()` still exists as a thin int-returning wrapper for back-compat.
- `manual_rating.py` — `/rate-message` write path. Atomic CSV upsert via temp-rename + flock.
- `notes.py` — `/add-note`.
- `content_scorer.py` + `claude_cli.py` — LLM scoring of fall-through-cluster messages via the `claude` CLI.
- `route_classifier.py` — Phase 5.5.2. `suggest_for_message(mid, cached_only=False)`, `record_correction(...)`, `backfill(limit, concurrency)`. CLI: `python -m mml_classifier.route_classifier --backfill --limit N --concurrency M`.
- `cluster_classifier.py` — Phase 4.5. `classify_message(mid, force=False)`, `backfill(...)`. Concatenates wrapper + universal doc into the system prompt at runtime.
- `rating_classifier.py` — Phase 6.0. `suggest_for_message(...)`, `backfill(...)`. Embeds the owner's last ~50 `message_ratings` (including `note`) as ground-truth few-shot examples.
- `prompt_refinement.py` — Phase 5.5.5. `refine(dry_run=False)`, `rollback()`. CLI for manual trigger + auto-fired from `/route-correction` after N corrections. Calls Claude (Sonnet by default) on the current prompt + 200 corrections; parses structured-JSON edits; applies anchor additions + verbatim phrase replacements; validates the candidate against required-section invariants; writes v{N+1}.md + atomically bumps `CURRENT_VERSION.txt`. Rollback reads `routing_prompt_versions.parent_version` to revert.
- `promote_corrections.py` — Phase 5.5.4. Mines `routing_corrections` for stable sender→folder patterns (≥3 corrections, no contradictions). Outputs a human table OR a Mailspring DevTools-paste snippet that calls `Actions.addMailRule` per stable pattern to materialize them as real Mailspring rules.
- `mailspring_intake.py` — Phase 4 ingest. Read-only on edgehill.db, write on warehouse, dry-run by default, APFS-clones backup before any `--commit`. Now also invoked by `/intake-now` HTTP endpoint (plugin-triggered) for live sync.
- `backfill.py` — content-score backfill batch.
- `db.py` — SQLite connection helpers (read_only / read_write context managers; URI percent-encoded for curly-apostrophe-safe paths).
- `config.py` — env-var-overridable paths, ports, model, thresholds, prompt versions. `ROUTING_PROMPT_VERSION` is now a runtime read from `prompts/CURRENT_VERSION.txt`, not a hardcoded constant.
- `prompts/` — all LLM prompts as text files. See "Prompt versions" below.

**Calendar files (Phase 5)** — see §5 below.

### 3. Plugin — `plugin/`

Mailspring 1.21 plugin (TypeScript/JSX, transpiled to `lib/` via `tsc`). Symlinked into Mailspring's package directory:

```
~/Library/Application Support/Mailspring/packages/mml-engagement-spike
  → plugin
```

The symlink name still says `mml-engagement-spike` — Mailspring loads packages by `package.json`'s `name` field (`mml-productivity`), not by directory name, so the rename is purely cosmetic.

**What the plugin does at activate-time** (`src/main.js export function activate`):

1. **Registers `EngagementBadge`** at `ComponentRegistry` role `ThreadListIcon` — the leftmost icon slot. Renders the four-layer badge per row. Source: `engagement-badge.jsx`. Layer components: `person-band.jsx` (filled round pill, manual rating), `rating-suggestion-chip.jsx` (hex pill, LLM-suggested rating — Phase 6.0.f), `category-tag.jsx` (gray cluster tag), `content-marker.jsx` (small dot). Dispatch order: **PersonBand** if `rating_source ∈ {manual, csv, priority_friend, family}` AND `rating >= PERSON_BAND_MIN_RATING` → **RatingSuggestionChip** if `suggested_rating >= 1` → **CategoryTag** if cluster is valid + non-fall-through → **ContentMarker** if TLDR present → blank. The 1–9 color palette is shared between PersonBand and the chip via `rating-colors.js`; only the shape differs (round = your decision, hex = system guess). Cluster-default ratings never surface as person pills.

2. **Registers `TldrOverlay`** at `MessageHeader` (and a few alternate roles since Mailspring 1.21's actual slot name is uncertain). Renders a TLDR box above the message body when `importance_score >= 0.6`. Source: `tldr-overlay.jsx`.

3. **Registers disposition keystrokes** `Cmd+Shift+1..4` (and `Cmd+Option+1..4` alternates) → moves focused thread to top-level `Pending`/`Waiting`/`Complete`/`Later` folders. Uses `ChangeFolderTask` for IMAP, `ChangeLabelsTask` for Gmail. Source: `disposition-actions.js`. Keymap JSON: `keymaps/mml-engagement-spike.json`. **Includes pre-emptive next-newer focus** (set 3× across 1.5s after the move) to defeat Mailspring's "prefer next-older unread" auto-focus heuristic so the cursor keeps moving forward in time.

4. **Registers route keystrokes** `Cmd+Option+A/B/C/E/F/M/P/S` → moves focused thread to `Routed/A`..`Routed/S` (8 placeholder folders; rename to your own taxonomy in `config.py` `ROUTING_FOLDERS` + the routing prompt + this dict). Source: `routed-keystroke-handler.js`. Keymap JSON: `keymaps/mml-routed.json`. Each press also logs a `routing_corrections` row (source = `accept`/`override`/`manual` depending on whether a cached LLM suggestion existed and matched). Uses the same `moveSelectedTo` helper as dispositions, so it gets the same forward-in-time focus pre-empt.

5. **Registers accept-suggestion keystroke** `Cmd+Option+Y` → opens the routing-confirm overlay (`route-confirm-overlay.jsx`, vanilla DOM). Overlay fetches the cached suggestion from `/route-suggest?cached_only=true` (instant render), shows `→ folder NN%` + LLM reason, and waits for the user's next keystroke: Y/Enter accepts, A/B/C/E/F/M/P/S overrides, N runs a fresh classification on-demand, Esc cancels.

6. **Registers manual-tag keystrokes** `Ctrl+Option+0..9` → instant `/rate-message` POST, no UI. Source: `tag-keystroke-handler.js`. Keymap JSON: `keymaps/mml-tags.json`. (Earlier prototype used `Ctrl+Cmd+digit`; remapped to `Ctrl+Option+digit` to avoid collisions with the Wispr Flow dictation tool's Control hotkey.)

7. **Registers note keystroke** `Ctrl+Option+N` → opens a vanilla-DOM input overlay near the focused message; on Enter, POSTs `/add-note`. Source: `note-keystroke-handler.js`, `note-input-overlay.js`.

8. **Registers create-event keystroke** `Ctrl+Option+E` (Phase 5) → opens event-input-overlay with LLM-drafted fields; on submit, POSTs `/create-event`. Source: `event-keystroke-handler.js`, `event-input-overlay.jsx`. Keymap JSON: `keymaps/mml-events.json`.

9. **Monkey-patches `SidebarSection.standardSectionForAccounts`** (Phase 5.5 + 5.5.6) to inject two custom unified parents into the "All Accounts" sidebar section:
   - **Processing** at index 1 (above Unread) — children: Pending, Waiting, Complete, Later, each aggregating that name's folder/label across all connected accounts.
   - **Routed** at index 2 (above Unread, below Processing) — one child per folder in `ROUTING_FOLDERS`, aggregating that suffix's `Routed/<name>` across all accounts. Folder discovery is prefix-based at runtime, so renaming folders requires no change here.
   Source: `sidebar-extension.js`. **Mailspring's public `ExtensionRegistry.AccountSidebar.register()` hardcodes children-by-account** (line 147 of internal sidebar-section.ts) — to get children-by-name we monkey-patch the internal module by resolving its path via `AppEnv.getLoadSettings().resourcePath`. Force-refreshes `SidebarStore._updateSections()` on activate so the patch takes effect immediately.

10. **Auto-intake listener** (Phase 5.5.3) — subscribes to `DatabaseStore` for Mailspring's persist events. When new `Message` rows arrive, debounces 5 s, then POSTs `/intake-now` so warehouse stays current automatically (no manual intake CLI run needed). Source: `auto-intake.js`.

11. **Monkey-patches `MailboxPerspective.prototype.threads`** for sort-by-engagement (deferred / not effective; Mailspring's MutableQuerySubscription bypasses it). See `spike_findings.md` for details.

12. **Monkey-patches `ThreadListColumns.Wide`** to insert a real "OwnerAddr" column between Participants and Date. Mailspring exposes no public API for this — see "Adding a column" gotcha below for the full 3-layer cache-busting incantation. Source: `installOwnerRecipientColumn()` in `main.js`. Column component: `owner-recipient-column.jsx`.

13. **Injects a `<style>` block** at activate to widen Mailspring's leftmost slot (which clips content narrower than its 16-20px design width) and to style all our custom classes. Inline CSS lives at the top of `main.js` (search for `STYLE_CSS`).

**The plugin → sidecar contract:** the plugin holds Mailspring `Thread` objects and needs RFC-822 Message-IDs to ask the sidecar about. `sidecar-client.js` `rfcIdsForThread(thread)` is the resolver — tries `thread.lastMessage.headerMessageId`, `thread.messages[]`, `thread.headerMessageId` (in-memory, fast) before falling through to `DatabaseStore.findAll(Message).where({threadId})` (slow + lazy-loaded). The fast paths matter — they're what fixed Phase 3's "badges don't render" bug.

**Plugin component → sidecar caching:** `sidecar-client.js` has three caches:
- `_threadIdsCache` — keyed by `thread.id`, TTL 60s. Avoids repeated ID resolution.
- `_threadStateCache` — keyed by sorted RFC-822 ID join, TTL 30s. Avoids repeated `/thread` HTTP calls.
- `_routeSuggestionCache` — keyed by RFC ID, TTL 5 min. Holds routing suggestions retrieved in-session.

All three bust on a successful `/rate-message`, `/add-note`, or routing decision.

### 4. Mailspring intake — Phase 4 + 4.2 (auto-intake)

Originally a one-shot CLI. Now also auto-triggered from the plugin so warehouse stays current without manual runs.

**CLI:**
```bash
cd services/mml-classifier
.venv/bin/python -m mml_classifier.mailspring_intake             # dry-run, no limit
.venv/bin/python -m mml_classifier.mailspring_intake --commit    # actually write
.venv/bin/python -m mml_classifier.mailspring_intake --limit 50  # cap for testing
```

**HTTP (`POST /intake-now`, Phase 5.5.3):** plugin auto-fires this ~5 s after `DatabaseStore` emits a `Message` persist event. Server-side: single-flight `_INTAKE_LOCK`, no APFS backup per call (auto-intake is too frequent for that — the CLI path still does backups). After commit, enqueues the freshly-inserted `message_id`s on all three classifier queues (routing, cluster, rating) so the suggestions are ready by the time the owner opens the thread.

**What it does:**
1. Reads `~/Library/Application Support/Mailspring/edgehill.db` (read-only URI).
2. Filters to messages newer than `MAX(messages.received_date)` in the warehouse.
3. Normalizes each row's JSON `data` blob → `messages` row + `recipients` rows.
4. Dedups against `messages.message_id` so re-runs are idempotent.
5. Auto-creates `contact_entities` + `contact_email_map` rows for unknown addresses.
6. Inserts under one transaction; rolls back on any failure.
7. APFS-clones a backup of `warehouse.sqlite` before any `--commit` (CLI path only).
8. Fans the new message_ids into the three classifier queues for background classification (auto-intake path).

**Default CLI behavior is dry-run** — prints summary + first 5 sample inserts + new addresses. Only `--commit` actually writes.

**Plan doc:** `the template plan files`.

### 5. Calendar integration (Phase 5) — `services/mml-classifier/mml_classifier/`

A **unified** calendar layer that serves two flows on the same schema:

| Flow | Trigger | What writes | `source` |
|---|---|---|---|
| Plugin-create | Ctrl+Option+E in Mailspring → overlay → submit | `event_creator.create_event` → GCal `events.insert` → mirror into warehouse | `'plugin-create'` |
| Ingest | `python -m mml_classifier.calendar_intake --commit` | `events.list?syncToken=...` → diff vs stored row → INSERT/UPDATE | `'gcal-sync'` |

Both write `events` + `event_attendees` + one `event_changes` row per observation. When ingest later sees an event the plugin created, it UPDATEs in place (matched by `(calendar_pk, gcal_event_id)`) and refreshes Google-state fields; `source` stays sticky to origin. Every meaningful change leaves a row in `event_changes` with `etag_before`/`etag_after` and a `diff_json` of changed fields, alongside the full Google payload in `snapshot_json` — meeting history can be replayed from there.

**Identity unification.** Attendee emails resolve through `contact_email_map` → `contact_entities` using the same auto-create logic as Mailspring intake. After ingest, "every interaction with person X" can UNION email recipients and event attendees on a single person id. This is the whole point of co-locating calendar in the warehouse.

**Module layout:**

| File | Purpose |
|---|---|
| `gcal_oauth_setup.py` | One-time CLI. Browser consent, writes `~/.config/mml-calendar/token.json` (default overridable via `MML_CLASSIFIER_GCAL_TOKEN_PATH`). Seeds the first `calendars` row with `is_default=1, is_primary=1`. |
| `gcal_oauth.py` | Runtime: `get_credentials()` loads + refreshes the token silently. `credentials_status()` powers `/healthz`. |
| `gcal_client.py` | Thin wrapper around `googleapiclient` — `insert_event()`, `list_calendars()`, `primary_account_email()`. |
| `event_drafter.py` | `/draft-event` backing logic. Loads message body + recipients from warehouse, calls Claude with `draft_event_v1.md` prompt + JSON schema. Filters the owner's own addresses from suggested attendees. Returns dataclass with title/start/duration/attendees + confidence. |
| `event_creator.py` | `/create-event` backing logic. Validates payload, calls GCal, writes the unified-schema rows in one transaction. |
| `calendar_normalize.py` | Pure data: Google event JSON → `NormalizedEvent` dataclass + attendees. Handles all-day, recurring instances, cancelled events, missing organizer, dedupe/lowercasing. |
| `calendar_history.py` | `compute_event_diff()` produces `{field_changes, attendees}` diff. `classify_change_kind()` picks `insert`/`update`/`cancel`. |
| `calendar_intake.py` | Ingest CLI. Dry-run default, APFS-clone backup before `--commit`, idempotent on `(calendar_pk, gcal_event_id)`. Uses syncToken for incremental sync; falls back to full backfill (`singleEvents=true`, `timeMin=2000-01-01`) on first run or 410 GONE. |

**OAuth setup (one-time, the owner does this, not Claude):**
1. Google Cloud Console → enable Calendar API → create OAuth2 Desktop credentials.
2. Download `client_secret_*.json` and save as `gcal_client_secrets.json` (gitignored).
3. `cd services/mml-classifier && .venv/bin/python -m mml_classifier.gcal_oauth_setup` — opens browser, completes consent, writes `gcal_token.json`, seeds the primary calendar in the warehouse.

After that, both flows work indefinitely (refresh token persists).

**Ingest CLI shape:**

```bash
cd services/mml-classifier

# Dry-run — print plan + sample changes, no writes
.venv/bin/python -m mml_classifier.calendar_intake

# Actually write
.venv/bin/python -m mml_classifier.calendar_intake --commit

# Force re-page everything (ignore stored sync_token)
.venv/bin/python -m mml_classifier.calendar_intake --commit --full-backfill

# Filter to one calendar
.venv/bin/python -m mml_classifier.calendar_intake --commit --calendar primary

# Cap for testing
.venv/bin/python -m mml_classifier.calendar_intake --commit --limit 50
```

**Migration:** `migrations/warehouse_calendar_migration.sql` + `warehouse_calendar_active_view_migration.sql`.

**The 5y / 1y window.** Google expands recurring events when `singleEvents=true`, so the first full backfill returned 56,905 rows including birthdays expanded to 2056. After the owner's 2026-05-10 decision:
- `calendar_intake.py` defaults `timeMin = now - 5y`, `timeMax = now + 1y` (overridable).
- `events_active` view filters `events` to the same window at query time. **Most queries should target `events_active`, not `events`.** The window slides automatically.
- Existing pre-window rows in `events` were intentionally not deleted — the view filters them.

### 6. Real-time LLM classifiers — Phases 4.5, 5.5.2, 6.0

The sidecar runs three parallel classifiers, each with the same architectural shape: prompt file + classifier module + background worker thread + cached_only HTTP endpoint + backfill CLI. They are independent — failure in one never blocks the others — and they share infrastructure (warehouse, claude_cli wrapper, intake fan-out, ThreadPoolExecutor backfill pattern).

| Phase | Decides | Module | Table | Worker |
|---|---|---|---|---|
| 5.5.2 | 1-of-N routing folder (`Routed/A`, `Routed/B`, ...) or `none` | `route_classifier.py` | `routing_suggestions` | `routing-worker` |
| 4.5 | 1-of-38 cluster (the historical taxonomy) | `cluster_classifier.py` | `message_classifications` | `cluster-worker` |
| 6.0 | 0–9 personal-priority rating | `rating_classifier.py` | `rating_suggestions` | `rating-worker` |

**Producer pattern.** All three queues are fed by `/intake-now` after a successful Mailspring intake commit. A single set of new `message_id`s is fanned out via `_enqueue_for_classification()` (routing), `_enqueue_for_cluster_classification()` (cluster), and `_enqueue_for_rating_classification()` (rating). Each enqueue uses a per-queue `_*_SEEN` set so a single id is never enqueued twice per process lifetime.

**Consumer pattern.** Each worker is a daemon thread with a `while not _ROUTING_STOP.is_set(): mid = queue.get(timeout=1.0); classify(mid)` loop. Errors are logged and swallowed; the worker exits cleanly on process shutdown.

**Cached-only API contract.** All three suggestion endpoints (`/route-suggest`, `/rating-suggest`) default to `cached_only:true` when called from the plugin. The endpoint reads the most recent row for `(message_id, classifier_version)` and returns it immediately. If the cache misses, it returns `{error: "not yet classified"}` — the plugin then has the option to ask for a fresh classification (Cmd+Option+Y overlay's "press N to classify now" path).

**Few-shot learning loop.** Both `route_classifier` and `rating_classifier` append recent corrections/ratings to their system prompt as ground-truth examples on every call. Routing reads `routing_corrections` (the last ~50 accept/override/manual decisions); rating reads `message_ratings` (the last ~50 manual tags, including any `note` the owner added). When sender/subject patterns repeat, the LLM pattern-matches against the owner's own decisions. The prompts also state explicitly that `override` decisions are "highest signal" — disagreements train faster than confirmations.

**Surfaces in the UI.** Each classifier's output reaches the owner differently:
- **Routing** — pull on demand. Cmd+Option+Y opens the confirm overlay; cached suggestion renders instantly; Y/letter/N/Esc → records `routing_corrections`.
- **Cluster** — passive. Drives the gray category tag in the badge and the cluster-default rating tier.
- **Rating** — passive (Phase 6.0.f). Hex chip in the badge, slot 1.5 (between PersonBand and CategoryTag), only when no person-level manual/CSV/family/priority-friend rating exists. Every Ctrl+Option+digit on a thread that had a visible chip is an implicit accept/override against that prediction — the data shape that 6.0.g (the rating-prompt self-refinement loop, deferred) will eventually consume.

**Cost shape.** All three default to Haiku via the `claude` CLI under the owner's Max OAuth. Warm-cache per-call cost is ~$0.005–$0.01 for routing/rating (small prompts, ~2k–6k tokens), ~$0.01–$0.02 for cluster (the 38-cluster doc is ~36k chars / ~9k tokens, larger). At the owner's typical mail rate (~50 new messages/day) the daily cost across all three classifiers is well under $1.

**Backfill CLIs** (each has the same shape):
```bash
.venv/bin/python -m mml_classifier.route_classifier   --backfill --limit 200 --concurrency 4
.venv/bin/python -m mml_classifier.cluster_classifier --backfill --limit 200 --concurrency 4
.venv/bin/python -m mml_classifier.rating_classifier  --backfill --limit 200 --concurrency 4
```

At concurrency 4, ~200 messages finishes in 10–15 min per classifier. The three are independent at the SQL layer so they can run in parallel terminals.

### 7. Self-refining routing prompt — Phase 5.5.5

The system improves its own routing prompt without human review. When the routing-correction counter crosses `ROUTING_REFINEMENT_TRIGGER_COUNT` (default 25 new corrections since the last refinement), `/route-correction` spawns a one-shot daemon thread that runs `prompt_refinement.refine()`:

1. Loads the current routing prompt (path from `prompts/CURRENT_VERSION.txt`).
2. Loads the most recent 200 `routing_corrections` rows formatted as `sender | subject | body | LLM_suggestion | user_choice | source`.
3. Calls Claude (Sonnet by default, configurable) with `prompts/refinement_meta_v1.md` as the system prompt — explicitly scoped: "you may ONLY (a) add anchor lines to the Known signals section, OR (b) replace verbatim phrases in folder-definition prose. You may NOT modify decision rules, output format, identity statement, or folder names."
4. Parses the structured-JSON proposal (`new_anchors`, `definition_refinements`, `no_change_needed_for`, `open_questions`, `overall_confidence`).
5. Applies edits via `apply_edits()`: anchors append into the Known-signals section; definition refinements do `str.replace(current_phrase, proposed_phrase)` only if `current_phrase` appears verbatim. Rejects edits for unknown folders or missing phrases.
6. Validates the candidate prompt: must contain `# Decision rules`, `# Output format`, `# The eleven folders`, `# Known signals` byte-for-byte; folder names must all still appear. Failures are quarantined to `prompts/_rejected/{ts}_v{N+1}.md` and the current version stays.
7. On success: writes `prompts/route_suggest_v{N+1}.md`, atomically rewrites `prompts/CURRENT_VERSION.txt`, inserts an audit row in `routing_prompt_versions`.

**Rollback** = `python -m mml_classifier.prompt_refinement --rollback` (resolves `parent_version` from the audit table and writes it back to `CURRENT_VERSION.txt`).

**Manual trigger** = `python -m mml_classifier.prompt_refinement [--dry-run]`. Dry-run prints the proposal + a unified diff vs the current prompt; no files written.

**Process lock** at `prompts/.refinement.lock` (`fcntl.LOCK_EX|LOCK_NB`) prevents concurrent refinements.

### 8. Promote-corrections-to-rules CLI — Phase 5.5.4

Independent layer on top of corrections data: mines `routing_corrections` for sender→folder patterns the owner has repeatedly confirmed (≥3 corrections, no contradictions) and generates Mailspring mail rules. The rules, once installed in Mailspring's `MailRules-V2` localStorage key (via the DevTools snippet the CLI emits), route mail from those senders automatically — bypassing the LLM entirely for the well-understood cases.

```bash
# Human-readable table of stable patterns
.venv/bin/python -m mml_classifier.promote_corrections [--min-count 3] [--since-days 14]

# Paste-ready DevTools JavaScript to materialize them as Mailspring rules
.venv/bin/python -m mml_classifier.promote_corrections --devtools-snippet
```

The end state of the routing loop: corrections train the LLM in-context → patterns stabilize → CLI surfaces them → Mailspring rules graduate them out of LLM scope entirely. Each layer makes the next one cheaper.

## Prompt versions

All LLM prompts live in `services/mml-classifier/mml_classifier/prompts/`. Routing is versioned via `CURRENT_VERSION.txt`; the others reference their version constant in `config.py`.

| Prompt | Version | Used by |
|---|---|---|
| `content_score_v1.md` | hardcoded | `content_scorer.py` (Phase 2) |
| `draft_event_v1.md` | hardcoded | `event_drafter.py` (Phase 5) |
| `route_suggest_v1.md` | retired | (original routing — owner-uninformed guesses) |
| `route_suggest_v2.md` | retired | (the owner's own folder definitions, locked 2026-05-10) |
| `route_suggest_v3.md` | retired | (v2 + per-folder anchors mined from the 36 imported Outlook rules) |
| `route_suggest_v4.md` | retired | (v3 + body inclusion + recent-corrections few-shot in system prompt) |
| `route_suggest_v5+` | **auto-deployed** | Generated by `prompt_refinement.py`; current version in `CURRENT_VERSION.txt` |
| `refinement_meta_v1.md` | constant | Meta-prompt for the self-refinement loop |
| `cluster_classify_v1.md` | constant | `cluster_classifier.py` (Phase 4.5). Wrapper; concatenates with `email_classification_instructions_universal.md` at runtime. |
| `rating_suggest_v1.md` | constant | `rating_classifier.py` (Phase 6.0). Embeds the owner's 0–9 scale + cluster→default-rating table; few-shot appended at runtime. |

## Data flows

### Flow 1 — A new message arrives in Mailspring

```
Mailspring IMAP sync
  → row in edgehill.db Message + (eventually) MessageBody
  → DatabaseStore emits a 'persist' event

Plugin auto-intake listener (auto-intake.js)
  → debounces 5s
  → POST /intake-now

Sidecar intake
  → reads edgehill.db, dedups by RFC-822 ID
  → INSERT into messages + recipients + contact_entities (if new)
  → enqueues new message_ids on routing-worker, cluster-worker, rating-worker

Background workers (parallel, ~1-15s each)
  → cluster-worker: classify_message() → message_classifications row
  → routing-worker: suggest_for_message() → routing_suggestions row
  → rating-worker:  suggest_for_message() → rating_suggestions row

The owner eventually scrolls inbox
  → plugin's EngagementBadge mounts per row
  → resolves thread → RFC-822 IDs
  → GET /thread?ids=<rfcs>
  → sidecar's resolve_thread() does the big JOIN
    → messages ⨝ message_classifications ⨝ sender_classifications
      ⨝ content_scores ⨝ message_ratings ⨝ recipients ⨝ rating_suggestions
    → ratings.effective_rating_decision() → (rating, rating_source)
    → latest rating_suggestion by scored_at → (suggested_rating, confidence, reason)
  → returns ThreadState
  → plugin renders Layer-1   (PersonBand round pill, source-gated) /
    Layer-1.5 (RatingSuggestionChip hex pill, when no PersonBand) /
    Layer-2   (CategoryTag) / Layer-3 (ContentMarker dot) / blank
```

### Flow 2 — the owner presses Ctrl+Option+5 on a thread (manual rating)

```
keymap: ctrl+alt+5 → 'mml-productivity:tag-5' command
  → tag-keystroke-handler.js handler fires
  → resolves focused message (FocusedContentStore + grain rule)
  → captures snapshot (rating, cluster from currently-rendered badge)
  → POST /rate-message {rfc_message_id, rating: 5, note: null,
                        what_i_saw_on_screen, plugin_version}
  → sidecar manual_rating.record_tag()
    → resolves rfc_message_id → warehouse PK
    → INSERT INTO message_ratings (message_id, rating, ...)
    → atomically updates contacts_to_rate.csv for the sender (bare-tag upsert)
  → returns 200 with rating_id
  → plugin busts thread cache → next render fetches fresh ThreadState
  → badge re-renders. If source is now 'manual' (it is) and rating >= 1
    (PERSON_BAND_MIN_RATING), PersonBand round pill shows. Otherwise the
    badge falls through to Layer 1.5 (RatingSuggestionChip hex pill, if
    suggested_rating >= 1), then Layer 2 (CategoryTag), then Layer 3,
    then blank.
```

### Flow 3 — the owner presses Ctrl+Option+N to add a note

```
keymap: ctrl+alt+n → 'mml-productivity:add-note' command
  → note-keystroke-handler.js handler fires
  → opens vanilla-DOM overlay near the message
  → user types reasoning + Enter
  → POST /add-note {rfc_message_id, note}
  → sidecar notes.add_note()
    → finds latest message_ratings row for this message
    → UPDATEs that row's note column (no new row inserted; rating value untouched)
  → on success: dismiss overlay
```

The note is now durable signal. Next time `rating_classifier.suggest_for_message()` runs, this row appears in the few-shot block as `sender | subject | body → rating (note: "...")` — the LLM uses the owner's reasoning to generalize.

### Flow 4 — Effective rating for a message (the heart of Layer-1)

`ratings.effective_rating_decision(sender_addr, cluster_id, priority_friend, manual_message_rating)` is called once per row in the thread JOIN. Returns `RatingDecision(rating, source)`. Override priority, highest wins:

| Tier | Source | Where it comes from |
|---|---|---|
| 0 | `MANUAL` | Latest `message_ratings.rating` for this message (Ctrl+Option+0..9 keystroke). |
| 1 | `CSV` | `contacts_to_rate.csv` rating column. the owner's hand-curated 1–9 per email. |
| 2 | `FAMILY` | `cluster_id = 3` → 9. |
| 3 | `PRIORITY_FRIEND` | `sender_classifications.priority_friend = 1` → floor of 8. |
| 4 | `CLUSTER_DEFAULT` | Auto-rule from cluster per `CLUSTER_DEFAULT_RATING` table. |
| 5 | `ZERO` | No signal → 0. |

The plugin gates the PersonBand round pill on `rating_source ∈ {MANUAL, CSV, PRIORITY_FRIEND, FAMILY}` AND `rating >= PERSON_BAND_MIN_RATING` (default 1, in `engagement-badge.jsx`). Cluster-default ratings are suppressed regardless of value — they're auto-derived fallbacks, not statements about a person.

When PersonBand is suppressed, the badge falls back to the Phase 6.0.f `RatingSuggestionChip` if `suggested_rating >= 1`. The chip uses the same 1–9 color palette but a hex shape so it reads as "system guess" rather than the owner's own decision; cluster name moves to the chip's tooltip. `suggested_rating == 0` is treated as "no signal" and falls through to the cluster tag — mirroring how `effective_rating_decision()` maps cluster-default/zero to a non-person-level source.

To change a cluster's default rating: edit `ratings.py` `CLUSTER_DEFAULT_RATING` dict and `docs/RATING_SCALE.md` to match. No CLI exists to manage this; it's source-code-level.

### Flow 5 — Phase 5 plugin-create-event (Ctrl+Option+E)

```
Mailspring email focused → Ctrl+Option+E
  → event-keystroke-handler.js fires
  → plugin opens event-input-overlay.jsx in "drafting…" state
  → POST /draft-event {rfc_message_id} (30s timeout, background)
  → sidecar event_drafter.draft_event()
    → loads message body + recipients from warehouse
    → calls claude_cli with draft_event_v1.md prompt + JSON schema
    → returns {title, description, proposed_start_iso, duration_minutes,
               attendees, confidence}
  → overlay populates fields; user edits
  → user submits → POST /create-event
  → sidecar event_creator.create_event()
    → resolves default calendar (calendars.is_default=1)
    → gcal_client.insert_event() → GCal API
    → in one transaction:
        INSERT INTO events (..., source='plugin-create')
        INSERT INTO event_attendees (one row per resp.attendees)
        INSERT INTO event_changes (change_kind='plugin-create',
                                    snapshot_json=resp)
  → returns {calendar_event_id, gcal_event_id, html_link, ...}
```

### Flow 6 — Calendar ingest (`calendar_intake --commit`)

```
.venv/bin/python -m mml_classifier.calendar_intake --commit
  → gcal_oauth.get_credentials() (refreshes silently if expired)
  → for each row in calendars (non-tombstone):
       fetch_events(service, calendar_id, sync_token, full_backfill?)
       build_plan(): for each raw event, normalize + diff vs existing row
  → APFS-clone backup → warehouse.sqlite.pre-calendar-intake-<ISO>
  → for each plan, in one transaction per calendar:
       insert / update / cancel / skip-same-etag
       wholesale-replace event_attendees
       INSERT INTO event_changes (change_kind, etag_before, etag_after,
                                   diff_json, snapshot_json)
       UPDATE calendars SET sync_token=<nextSyncToken>, synced_at=now
```

### Flow 7 — Manual route move (Cmd+Option+B for deals)

```
keymap: mod+alt+b → 'mml-productivity:route-to-deals' command
  → routed-keystroke-handler.js fires
  → reads cached LLM suggestion (sidecar-client _routeSuggestionCache, no HTTP)
  → moveSelectedTo('Routed/deals', [thread]):
       findCategoryByName(account, 'Routed/deals')
       ChangeFolderTask (IMAP) or ChangeLabelsTask (Gmail) — Actions.queueTask
  → pre-empts focus: captures next-newer unmoved thread BEFORE the move,
       schedules Actions.setFocus 3× over 1.5s
  → POST /route-correction {rfc_message_id, suggested_folder?,
       accepted_folder='Routed/deals',
       source='manual' (no cached suggestion) | 'accept' (matches) | 'override' (mismatch),
       plugin_version}
  → sidecar route_classifier.record_correction() → routing_corrections row
  → sidecar bumps the refinement counter; if ≥ trigger threshold,
    spawns a refinement thread (see Flow 9)
```

### Flow 8 — Cmd+Option+Y (accept LLM routing suggestion)

```
keymap: mod+alt+y → 'mml-productivity:accept-suggestion'
  → accept-suggestion-handler.js opens route-confirm-overlay
  → overlay POST /route-suggest {rfc_message_id, cached_only: true} (3s timeout)
  → instant render:
       "→ folder NN%" + LLM reason + Y/letter/Esc hints   (cache hit)
                  OR
       "⏳ Not yet classified" + "press N to classify now" (cache miss)
  → user key:
       Y/Enter → moveSelectedTo(suggested_folder) + record 'accept'
       letter  → moveSelectedTo(LETTER_TO_FOLDER[key]) +
                  record 'accept' (match) or 'override' (mismatch)
       N (only on cache miss) → POST /route-suggest {cached_only: false}
                                  (60s timeout for cold Claude CLI)
       Esc/backdrop → dismiss
  → moveSelectedTo runs the same recipe as Flow 7 (queueTask + focus pre-empt)
```

### Flow 9 — Self-refinement after N corrections (Phase 5.5.5)

```
Every /route-correction increments _NEW_CORRECTIONS_SINCE_REFINEMENT
  → if >= ROUTING_REFINEMENT_TRIGGER_COUNT (default 25):
       reset counter
       spawn one-shot daemon thread:
         acquire prompts/.refinement.lock (LOCK_EX|LOCK_NB)
         load current prompt + last 200 corrections
         claude_cli.call(sonnet) with refinement_meta_v1.md system prompt
         parse structured JSON {new_anchors, definition_refinements, ...}
         apply_edits():
           - regex-locate Known signals section, append anchor lines
           - for each refinement, str.replace(current_phrase, proposed_phrase)
             (verbatim match required; otherwise dropped)
         validate candidate (required headers, folder names intact)
         if valid:
           write prompts/route_suggest_v{N+1}.md
           atomic rewrite prompts/CURRENT_VERSION.txt
           INSERT INTO routing_prompt_versions (...)
         else:
           write to prompts/_rejected/{ts}_v{N+1}.md
           log error
```

Next /route-suggest call reads the new version via `config._read_current_prompt_version()`. Existing `routing_suggestions` cached at the previous version are invisible to the new version's lookups; future classifications create fresh rows.

## Key conventions and gotchas

### Path handling

macOS / iCloud Drive can produce paths that look malformed but are correct. Two that bit us in development:

1. **Curly apostrophes.** Folder names like `name's Mac Studio` use U+2019 (curly) by default, not U+0027 (straight). Don't normalize.
2. **iCloud doubled folder names.** `Documents/Documents - <device>/` — the second `Documents - <device>` is genuine when iCloud's "Desktop & Documents Folders" sync is on; never dedupe.

**Rule:** if a path doesn't resolve, do NOT silently rewrite. Report what you tried and ask. The user's CLAUDE.md may codify additional traps (non-breaking spaces, em dashes, NFC vs NFD normalization).

### Mailspring 1.21 API surface

| Symbol | Notes |
|---|---|
| `ComponentRegistry.register(C, { role })` | The plugin extension primitive. Roles: `ThreadListIcon`, `ThreadListTimestamp`, `ThreadListQuickAction`, `MessageHeader` (uncertain). |
| `AppEnv.commands.add(document.body, name, handler)` | Register keystroke handlers. Plugin `keymaps/*.json` is auto-loaded. |
| `AppEnv.keymaps.add` | DOES NOT exist. Don't try. |
| `ExtensionRegistry.AccountSidebar.register(...)` | Hardcodes children-by-account at `sidebar-section.ts:147` — useless if you need children-by-name. Monkey-patch the internal `SidebarSection.standardSectionForAccounts` instead. |
| `Cmd+1..9` | Reserved by Mailspring (account select). Use `Cmd+Shift+...` or `Cmd+Option+...`. |
| `Cmd+Shift+3/4` | Collide with macOS screenshots. Use `Cmd+Option+3/4` as alts (also reserved by our disposition handler). |
| `Cmd+Option+D` | Collides with macOS Show/Hide Dock. We use `Cmd+Option+B` for `Routed/deals` instead. |
| `Ctrl+<anything>` | If you use a dictation tool that captures Control globally (e.g. Wispr Flow with default settings), Ctrl-chords don't reach Mailspring. Either reconfigure the dictation tool or avoid bare Ctrl in keymaps. |
| `Option+<digit>` (alone) | macOS produces typographic chars (`Option+1` = ¡, `Option+2` = ™). The keymap won't fire — the layout layer remaps before Mousetrap sees it. With another modifier (Ctrl, Cmd) the digit reaches the app intact. |
| `ChangeFolderTask` (singular) | For IMAP/Zoho moves. `{ source, threads, folder }`. |
| `ChangeLabelsTask` (plural) | For Gmail moves. `{ source, threads, labelsToAdd, labelsToRemove }`. |
| `Actions.queueTask(task)` | Use this for ChangeFolderTask/ChangeLabelsTask. `TaskQueue.queue(task)` exists but silently fails — tasks never propagate to mailsync. |
| `Actions.setFocus({collection: 'thread', item})` | Pre-empt Mailspring's auto-focus heuristic after a move. Fire 3× over 1.5s to win the race vs `ThreadListStore._onDataChanged`. |
| `Actions.focusMailboxPerspective(current)` | NO-OP when the perspective equals the currently focused one. Don't use it as a re-render trigger. |
| `Thread.participants` | Property (array), NOT a method. |
| `Thread.lastMessage` | IS populated for closed inbox rows. Has `.headerMessageId`. |
| `DatabaseStore.findAll(Message).where({threadId})` | Returns `[]` for closed threads (lazy-loaded). Use `thread.lastMessage` for the fast path. |
| `DatabaseStore.listen(cb)` | Reflux subscription. Fires on every persist/unpersist. Filter by `change.objectClass === 'Message' && change.type === 'persist'` to detect new mail. |
| `ThreadListColumns.Wide` / `.Narrow` | `Wide` is 5 cols; `Narrow` is 1. ThreadList picks based on `state.style`. No public column-extension API. |
| `MultiselectList.getDerivedStateFromProps` | Referential `props.columns !== state._lastColumns` check. Splice-mutation is INVISIBLE to it. |
| `ListTabularItem._columnCache` | Per-row cell-render cache. Stale after a column inject unless explicitly nulled per-row. |
| `react-dom` | NOT exposed in the plugin sandbox. Use vanilla DOM for portal-style UIs (note overlay, route-confirm overlay). |
| `mailspring-exports` does NOT expose `SidebarStore`/`SidebarItem`/`SidebarSection` | Must resolve them at runtime via `path.join(AppEnv.getLoadSettings().resourcePath, 'internal_packages/account-sidebar/lib/...')`. Mailspring's package.asar loader makes the require transparent. |
| DevTools paste | Mailspring's renderer console requires typing `allow pasting` once per session before multi-line paste works. |

### Sidecar behavior contract

- **Always returns 200.** Errors come back as `{error: "..."}`. Plugin treats sidecar-down (timeout) as silent fail.
- **1000ms hard fetch timeout** in plugin's `_fetch` (`sidecar-client.js FETCH_TIMEOUT_MS`). Routing's cached-only path uses 3s; the cold-classify path uses 60s; refinement uses 300s for the Sonnet meta-call.
- **Single-flight `/score-now` and `/intake-now`.** Lock-protected; concurrent calls return `busy: true` immediately.
- **Append-only writes.** Re-rating creates a new `message_ratings` row; latest wins via `(rated_at DESC, id DESC)`. Same shape for `routing_suggestions` and `rating_suggestions` (cached lookups filter on `classifier_version`). Only the `note` column on the latest `message_ratings` row is in-place updateable.

### Cache invalidation via classifier_version

Each LLM table tags every row with the `classifier_version` that produced it (e.g. `route_suggest_v5@haiku`). Lookups always include this filter — so when the prompt bumps, the old rows become invisible to the new version's reads without any DELETE. Re-classification on the same message at the new version creates a fresh row alongside the old one. **This is how the self-refinement loop avoids destroying its own training data** — every prior decision stays available for audit.

### Auto-deploy with version-pointer file (Phase 5.5.5)

The pattern: store the "live" version in a tiny single-line file (`prompts/CURRENT_VERSION.txt`). The module reads it at config-load time. Atomic rewrite (temp+rename) makes deploys instant; rollback is a one-line file overwrite. This pattern is reusable for any prompt that needs to self-evolve — apply it to `rating_suggest` and `cluster_classify` if/when we wire self-refinement on those too.

### CSV vs warehouse for ratings

`contacts_to_rate.csv` is the **user-facing** rating system. the owner hand-edits it (or auto-rules append to it). The CSV's `rating` column drives the badge color via `ratings.effective_rating_decision()` tier 1 (source = `CSV`).

The warehouse `message_ratings` table is the **per-message override**. If the owner hits Ctrl+Option+5 on one specific email, that row in `message_ratings` overrides the CSV's per-sender rating for that one message (tier 0, source = `MANUAL`). The CSV is also updated atomically as a side-effect of bare tags (no note).

This means: to change a person's overall rating, edit `contacts_to_rate.csv`. To change a single message's rating, use the keystroke. To explain WHY, follow up with Ctrl+Option+N — the note is durable signal that feeds the next `rating_classifier` few-shot.

### Adding a column to ThreadList — the full re-render incantation

Mailspring 1.21 has no public API to inject a thread-list column. To make `installOwnerRecipientColumn()` actually visually render (not just *log* that it ran), the plugin defeats three layers of caching in Mailspring's internal render path. Each one was discovered the hard way; this is the chain (top to bottom, all required):

1. **`tlc.Wide` must be a NEW array reference.** Mailspring's `internal_packages/thread-list/thread-list.js` imports the columns module via `__importStar`. Because the source is `__esModule: true`, the namespace return is the same `exports` object — so `tlc.Wide = newWide` is visible to the consumer's `ThreadListColumns.Wide` reads. **In-place splice does not work** — same reference defeats the prop diff downstream.

2. **`MultiselectList.state.computedColumns` and `state._lastColumns` must be injected directly.** When activate runs, Mailspring's initial render is already done; MultiselectList's `_lastColumns` already captured the original 5-element array. Subsequent `getDerivedStateFromProps` calls compare `props.columns !== state._lastColumns` (referential). The plugin walks the React fiber tree up from `.thread-list` to find the MultiselectList instance and `setState({computedColumns, _lastColumns})` directly.

3. **`ListTabularItem._columnCache` must be nulled on every live row.** Each row caches its column-rendered cells in `_columnCache`. The cache invalidates only when `this.props.columns !== nextProps.columns`. The plugin walks every `.list-item.list-tabular-item` in the DOM, finds its ListTabularItem fiber, sets `_columnCache = null`, and `forceUpdate()`s it.

Side gotchas:
- **`Actions.focusMailboxPerspective(current)` is a no-op** when the dispatched perspective equals the focused one.
- **`window.addEventListener('resize')`** is what causes ThreadList's `state.style` to flip from `'unknown'` to `'wide'`/`'narrow'`.
- **DevTools requires `allow pasting`** before multi-line paste works.
- **Empty-column UX trap:** if `resolver()` returns `null` for missing data, the cell renders as an empty div. Always render a placeholder ("·") so column existence is visible regardless of data availability.

The whole chain is in `plugin/src/main.js`:
- `installOwnerRecipientColumn()` — patches `tlc.Wide`.
- `injectColumnsWithRetries()` → `injectColumnsIntoMultiselectList()` — fiber walks + setState.
- `nukeListTabularItemCaches()` — fiber walks every `.list-item` and nulls its cache.

If a future Mailspring upgrade breaks any link of this chain, that's where to look.

### Post-move thread focus

Mailspring's `ThreadListStore._onDataChanged` auto-picks focus after a thread leaves the visible list, using a heuristic that prefers the next-OLDER thread when the next-newer one is already read (it's optimized for "go to the next unread item"). In a busy triage workflow this moves the cursor backward in time on every disposition. Fix: in `moveSelectedTo()`, capture the next-newer unmoved thread BEFORE the move, then fire `Actions.setFocus + Actions.setCursorPosition` three times (0ms, 50ms, 1.5s) so we win regardless of when Mailspring's heuristic runs.

## Phase status (as of 2026-05-11)

| Phase | Status |
|---|---|
| 0 — warehouse schema + 31-cluster taxonomy doc | ✅ Shipped 2026-05-07 |
| 1 — Mailspring plugin spike (badge, keystrokes, sort exploration) | ✅ Shipped 2026-05-08 |
| 2 — sidecar + LLM scoring + cluster classification (batch) | ✅ Shipped 2026-05-08 |
| 2.5 — manual tagging (sidecar + Ctrl+Cmd+0..9 keymap) | ✅ Shipped 2026-05-08 |
| 3 — plugin production: 3-layer badge, TLDR overlay, note keystroke | ✅ Shipped 2026-05-09 |
| 4 — Mailspring → warehouse intake (one-shot CLI) | ✅ Shipped 2026-05-09 |
| 4 (column) — OwnerAddr column via monkey-patch | ✅ Verified 2026-05-10 (3-layer cache-busting) |
| 4.5 — real-time cluster classifier (Phase 2 prompt run live, per-message) | ✅ Shipped 2026-05-11 |
| 5 — Unified calendar (plugin create-event + ingest CLI on shared schema) | ✅ Schema + code + tests landed 2026-05-10. Migration applied. Awaiting OAuth setup. |
| 5.5 — Unified `Routed` sidebar parent (children by name, cross-account) | ✅ Shipped 2026-05-10 |
| 5.5.1 — Cmd+Option+<letter> route keystrokes (8 folders + correction logging) | ✅ Shipped 2026-05-10 |
| 5.5.2 — LLM routing suggester (route_classifier, /route-suggest, /route-correction) | ✅ Shipped 2026-05-10 |
| 5.5.3 — Auto-intake (DatabaseStore listener → /intake-now → 3-queue fan-out) | ✅ Shipped 2026-05-10 |
| 5.5.4 — Confirmation overlay (Cmd+Option+Y, cached-only-first, classify-on-demand fallback) | ✅ Shipped 2026-05-10 |
| 5.5.5 — Self-refining routing prompt (Sonnet meta-call, auto-deploy with rollback) | ✅ Shipped 2026-05-10 |
| 5.5.6 — Processing folder unified parent (Pending/Waiting/Complete/Later cross-account) | ✅ Shipped 2026-05-11 |
| 6.0 — Rating suggester data layer (rating_classifier, /rating-suggest, few-shot from notes) | ✅ Shipped 2026-05-11 |
| 6.0.f — Plugin badge chip showing LLM-suggested rating (hex pill, layer 1.5) | ✅ Shipped 2026-05-11 |
| 6.0.g — Self-refinement loop for rating prompt (Phase 5.5.5 analog) | ❌ Deferred |
| 4.2 — Continuous live ingest (5-min poll vs current auto-intake on persist events) | ⚠️ Largely subsumed by 5.5.3 auto-intake |
| 4.5+ — Smart entity dedup (fragmented `contact_entities` cleanup) | ❌ Not yet |
| 5.1 — Secondary calendar ingest (BPC Work, Clickup Mirror, Calendly) | ❌ Not yet — `--calendar <id>` already supports it; just need to seed rows |
| 5.2 — Calendar event LLM classification + topic tagging | ❌ Not yet |
| 6+ — Tailscale exposure, Litestream, Neo4j projection, conductor v1 (rule-mining) | ❌ Deferred |

## Where to look for what

**"How does X get rated?"**
→ Start at `ratings.effective_rating_decision()`. Trace tiers. Then `contacts_to_rate.csv` for the per-person CSV. Then `RATING_SCALE.md` for cluster defaults.

**"How does X get classified into a cluster?"**
→ `cluster_classifier.classify_message()` (real-time, Phase 4.5). For PST-era data, see `pipeline_scripts/classification/extract_phase2.py`. The cluster definitions live in `email_classification_instructions_universal.md`.

**"How does X get an LLM routing suggestion?"**
→ `route_classifier.suggest_for_message()`. Cache-only via `/route-suggest`. Background worker auto-fires after intake. Current prompt name is in `prompts/CURRENT_VERSION.txt`.

**"How does X get an LLM rating suggestion?"**
→ `rating_classifier.suggest_for_message()`. Same shape as routing.

**"How does the routing prompt self-improve?"**
→ Every `/route-correction` bumps a counter. When it hits 25 corrections, `server._handle_route_correction()` spawns a daemon thread that runs `prompt_refinement.refine()`. Audit trail in `routing_prompt_versions` table.

**"Why isn't a badge showing?"**
→ Check sidecar log: `tail -f ~/Library/Logs/mml-classifier/stderr.log`. Look for `/thread?ids=` traffic. If absent, plugin isn't calling sidecar. If present but `matched_message_count: 0`, the message isn't in warehouse — auto-intake may have failed; manually run `python -m mml_classifier.mailspring_intake --commit`.

**"Why isn't a PersonBand pill showing on a thread that should have one?"**
→ The `rating_source` returned by `/thread` must be in `{manual, csv, priority_friend, family}` AND `rating >= PERSON_BAND_MIN_RATING` (default 1 in `engagement-badge.jsx`). Inspect via `curl -sS 'http://127.0.0.1:8765/thread?ids=<rfc>' | jq`. If `rating_source = 'cluster_default'` that's why — the rating came from a fallback, not a person-level signal. Threads in that state should still show a hex rating-suggestion chip (Phase 6.0.f) if the rating classifier has produced a row at the current `RATING_CLASSIFIER_VERSION`.

**"Why isn't a hex rating-suggestion chip showing on a thread that should have one?"**
→ Check `suggested_rating` in `/thread`'s response — it must be ≥ 1. If it's `null`, the rating worker hasn't processed this message yet at the current `classifier_version`. New mail gets classified on intake (via `/intake-now` fan-out); historical mail needs `python -m mml_classifier.rating_classifier --backfill --limit N --concurrency 4`. If `suggested_rating == 0` the classifier explicitly judged "no signal" and the chip is suppressed by design.

**"Why isn't the OwnerAddr column showing?"**
→ It almost certainly *is* — just empty. Verify with `document.querySelector('.list-column-OwnerAddr')` in DevTools (`allow pasting` first). Cells populate from `to_me_addr` in ThreadState — empty until intake has run on that message.

**"How do I add a new keystroke?"**
→ Add a row to the appropriate `keymaps/*.json`. Add a handler module under `src/`. Register in `main.js activate()`. Watch out for macOS chord collisions (see "Mailspring API surface" table for known ones).

**"How do I add a sidecar endpoint?"**
→ Add a route in `server.py do_GET` or `do_POST`. Add `_handle_xxx()` method. Add tests under `tests/`. Restart the daemon (`launchctl kickstart -k gui/$(id -u)/com.mml.classifier` or the `kill + nohup` pattern below).

**"How do I add a column to the thread list?"**
→ Reuse the 3-layer cache-bust pattern in `installOwnerRecipientColumn()`.

**"How do I add a new badge layer (sibling to PersonBand / RatingSuggestionChip / CategoryTag / ContentMarker)?"**
→ Create a new component under `src/` returning a single `<span>` with a `mml-*` class. Add it to `engagement-badge.jsx`: import it, extend `pickLayer(state)` with a new branch returning a new layer name, and add a `if (layer === '<name>')` render branch. If your layer reads a new field from ThreadState, extend `thread_lookup.py` (JOIN + aggregation + ThreadState dataclass field) and update the `/thread` JSDoc in `sidecar-client.js`. CSS rules go in `STYLE_CSS` in `main.js`. Phase 6.0.f is the worked example.

**"How do I add a new sidebar unified parent?"**
→ Extend `sidebar-extension.js` — add a new `buildUnifiedXItem(accounts)` helper paralleling `buildUnifiedProcessingItem()`, then add a splice call in `injectInto()` at the desired index. No new infrastructure needed.

**"How do I add a new sidebar extension OR keep a public API path?"**
→ Don't use `ExtensionRegistry.AccountSidebar.register()` for cross-account children-by-name — it forces children-by-account. Monkey-patch `SidebarSection.standardSectionForAccounts` directly (the pattern is in `sidebar-extension.js`).

**"How do I add a new contact_entity field?"**
→ Schema migration in `migrations/`. Run against a copy first. Update intake if the field needs population.

**"How do I run the classifier on new messages?"**
→ Cluster: `python -m mml_classifier.cluster_classifier --backfill --limit N --concurrency M`. Routing: `python -m mml_classifier.route_classifier --backfill ...`. Rating: `python -m mml_classifier.rating_classifier --backfill ...`. All three are independent at the SQL layer; run them in parallel terminals if you want.

**"How do I propose a new routing prompt rule manually?"**
→ `python -m mml_classifier.prompt_refinement --dry-run` — runs the meta-LLM against current corrections, prints the proposed v{N+1} and a diff, writes nothing. Re-run without `--dry-run` to deploy.

**"How do I roll back a bad prompt deploy?"**
→ `python -m mml_classifier.prompt_refinement --rollback` — reads `routing_prompt_versions.parent_version` for the current version and writes it back to `prompts/CURRENT_VERSION.txt`. Next `/route-suggest` reads the old version.

## File index — most useful files to grep first

```
mml-productivity-template/
├── README.md
├── LICENSE                                        ← MIT
├── SETUP.md                                       ← end-to-end installation (start here)
├── docs/
│   ├── ARCHITECTURE.md                            ← you are here
│   ├── BUILD_GUIDE.md                             ← phase-by-phase narrative of what was built and why
│   ├── RATING_SCALE.md                            ← what each 0–9 means
│   ├── CLASSIFICATION_TAXONOMY.md                 ← taxonomy-generator workflow
│   ├── PROMPT_REFINEMENT.md                       ← Phase 5.5.5 self-refinement loop
│   ├── Integration.md
│   ├── MAILSPRING_SETUP.md
│   ├── MAILSPRING_API_NOTES.md
│   ├── MAILSPRING_RULES_RECIPE.md
│   ├── FUTURE_IMPROVEMENTS.md
│   └── AI_BUILD_PROMPT.md
├── templates/
│   ├── contacts_to_rate.template.csv
│   ├── priority_friends.template.md
│   ├── mailspring_rules.template.json
│   ├── .env.template
│   ├── email_classification_instructions_universal.template.md
│   └── gcal_client_secrets.template.json
│
├── migrations/                                    ← all schema migrations, in order
│   ├── 00_warehouse_schema.sql                    ← Phase 0
│   ├── 01_content_scores.sql                      ← Phase 2
│   ├── 02_message_ratings.sql                     ← Phase 2.5
│   ├── 03_disposition.sql                         ← Phase 3
│   ├── 04_calendar.sql                            ← Phase 5
│   ├── 05_calendar_active_view.sql                ← Phase 5
│   ├── 06_routing.sql                             ← Phase 5.5.2
│   ├── 07_prompt_versions.sql                     ← Phase 5.5.5
│   ├── 08_rating_suggestions.sql                  ← Phase 6.0
│   └── HISTORY.md                                 ← migration sequence + naming notes
│
├── pipeline/                                      ← bronze→silver ingest scripts (PST / IMAP)
│   ├── build_entities.py
│   ├── rebuild_contacts_csv.py
│   ├── … (Phase 1 ingest)
│   └── …
│
├── tools/                                         ← operator CLIs
│   ├── parse_rwz.py                               ← Outlook .rwz parser (rule import)
│   ├── dump_rated_contacts.py                     ← markdown audit doc
│   ├── dump_rated_contacts_xlsx.py                ← spreadsheet audit doc
│   └── taxonomy_generator.py                      ← propose your cluster taxonomy from the warehouse
│
├── plugin/                                        ← the Mailspring plugin
│   ├── package.json                               ← name=mml-productivity
│   ├── tsconfig.json                              ← tsc src/ → lib/
│   ├── keymaps/                                   ← auto-loaded by Mailspring
│   │   ├── mml-engagement-spike.json              ← Cmd+Shift+1..4 + Cmd+Option+1..4 dispositions
│   │   ├── mml-tags.json                          ← Ctrl+Option+0..9 ratings + Ctrl+Option+N note
│   │   ├── mml-events.json                        ← Ctrl+Option+E event drafting
│   │   └── mml-routed.json                        ← Cmd+Option+letter routes + Cmd+Option+Y accept
│   ├── src/
│   │   ├── main.js                                ← activate(), CSS, column install, sidebar/route/auto-intake wiring
│   │   ├── engagement-badge.jsx                   ← multi-layer dispatch + rating_source gate
│   │   ├── person-band.jsx                        ← rating-1-to-9 colored round pill (manual)
│   │   ├── rating-suggestion-chip.jsx             ← rating-1-to-9 hex pill (LLM-suggested, Phase 6.0.f)
│   │   ├── rating-colors.js                       ← shared 1-9 palette (PersonBand + chip)
│   │   ├── category-tag.jsx                       ← cluster muted tag
│   │   ├── content-marker.jsx                     ← tiny dot
│   │   ├── tldr-overlay.jsx                       ← above-message-body box
│   │   ├── owner-recipient-column.jsx             ← OwnerAddr column cell
│   │   ├── sidecar-client.js                      ← fetch + caches + all sidecar verbs
│   │   ├── disposition-actions.js                 ← moveSelectedTo + post-move focus pre-empt
│   │   ├── tag-keystroke-handler.js               ← Ctrl+Option+0..9
│   │   ├── note-keystroke-handler.js              ← Ctrl+Option+N
│   │   ├── note-input-overlay.js                  ← vanilla DOM note overlay
│   │   ├── event-keystroke-handler.js             ← Ctrl+Option+E (Phase 5)
│   │   ├── event-input-overlay.jsx                ← LLM-drafted event UI
│   │   ├── routed-keystroke-handler.js            ← Cmd+Option+letter
│   │   ├── accept-suggestion-handler.js           ← Cmd+Option+Y trigger
│   │   ├── route-confirm-overlay.jsx              ← LLM routing confirmation overlay (vanilla DOM)
│   │   ├── sidebar-extension.js                   ← Processing + Routed unified parents (monkey-patch)
│   │   ├── auto-intake.js                         ← DatabaseStore listener → debounced /intake-now
│   │   └── engagement-stub.js                     ← legacy hash-based rating; mostly dead
│   └── lib/                                       ← tsc output; what Mailspring loads (committed)
│
├── services/mml-classifier/                       ← the sidecar
│   ├── pyproject.toml
│   ├── launchd/
│   │   └── com.mml.classifier.plist               ← symlinked into ~/Library/LaunchAgents/
│   ├── tests/                                     ← pytest
│   └── mml_classifier/
│       ├── server.py                              ← HTTP routing, 3 worker threads, intake hook, refinement trigger
│       ├── thread_lookup.py                       ← /thread aggregation SQL (with rating_source)
│       ├── manual_rating.py                       ← /rate-message + CSV upsert
│       ├── notes.py                               ← /add-note
│       ├── content_scorer.py                      ← /score-now LLM body-read
│       ├── claude_cli.py                          ← shell-out to `claude` binary; takes optional model=
│       ├── ratings.py                             ← RatingSource enum + effective_rating_decision()
│       ├── mailspring_intake.py                   ← Phase 4 intake (CLI + /intake-now HTTP)
│       ├── backfill.py                            ← content-score batch CLI
│       ├── db.py                                  ← sqlite URI helpers
│       ├── config.py                              ← env-overridable constants + CURRENT_VERSION.txt reader
│       │
│       │  --- Phase 5.5.2 routing ---
│       ├── route_classifier.py                    ← suggest + record_correction + backfill
│       ├── prompt_refinement.py                   ← Phase 5.5.5 self-refinement
│       ├── promote_corrections.py                 ← Phase 5.5.4 stable-pattern miner CLI
│       │
│       │  --- Phase 4.5 cluster ---
│       ├── cluster_classifier.py                  ← real-time per-message classifier
│       │
│       │  --- Phase 6.0 rating ---
│       ├── rating_classifier.py                   ← LLM 0–9 suggester
│       │
│       │  --- Phase 5 calendar ---
│       ├── gcal_oauth_setup.py                    ← one-time consent CLI; seeds calendars row
│       ├── gcal_oauth.py                          ← runtime token load+refresh
│       ├── gcal_client.py                         ← googleapiclient wrapper
│       ├── event_drafter.py                       ← /draft-event
│       ├── event_creator.py                       ← /create-event
│       ├── calendar_normalize.py                  ← Google event JSON → NormalizedEvent
│       ├── calendar_history.py                    ← diff + change_kind classifier
│       ├── calendar_intake.py                     ← ingest CLI
│       │
│       └── prompts/                               ← all LLM prompts as text
│           ├── CURRENT_VERSION.txt                ← single-line pointer; rewritten by prompt_refinement
│           ├── route_suggest_v1.md                ← retired
│           ├── route_suggest_v2.md                ← retired
│           ├── route_suggest_v3.md                ← retired
│           ├── route_suggest_v4.md                ← retired
│           ├── route_suggest_v5+.md               ← auto-deployed (current per CURRENT_VERSION.txt)
│           ├── refinement_meta_v1.md              ← Phase 5.5.5 meta-prompt
│           ├── cluster_classify_v1.md             ← Phase 4.5 wrapper (concat'd with universal doc)
│           ├── rating_suggest_v1.md               ← Phase 6.0 rating prompt
│           ├── content_score_v1.md                ← Phase 2 content scorer
│           └── draft_event_v1.md                  ← Phase 5 event drafter
```

## Building new features — defaults and traps

- **Don't change the warehouse schema** without a migration script and a copy-first-then-swap dance. The DB is 600 MB+ and slow to recreate.
- **Don't bypass the sidecar.** The plugin should ALWAYS go through HTTP, even for queries that look readable from the warehouse directly. Keeps the contract clean and lets the sidecar do caching/aggregation.
- **Don't introduce new dependencies in the plugin sandbox.** No `react-dom`, no `lodash`, no `axios`. Vanilla `fetch`, vanilla DOM where possible, and what `mailspring-exports` / `mailspring-component-kit` offer.
- **Don't introduce FastAPI / aiohttp in the sidecar.** It's stdlib `http.server` deliberately — small, no upgrades to manage, fast enough.
- **Reuse the worker+queue pattern** for any new background LLM classifier. Three of them now share infrastructure (`_*_QUEUE`, `_*_SEEN`, daemon thread, intake fan-out). The fourth one follows the same template.
- **Cache rows by `classifier_version`.** Append-only, never UPDATE. Bumping the version is the cache-invalidation primitive — no DELETE, no schema change.
- **Use the version-pointer-file pattern** for any prompt that needs self-evolution (Phase 5.5.5). Atomic temp+rename writes; rollback is a one-line file change.
- **Surface LLM output as a visible chip if you want correction signal.** the owner's keystrokes (Ctrl+Option+digit for rating, Cmd+Option+letter for routing) are only useful as accept/override training data if the owner saw the prediction first. Phase 6.0.f is the pattern: render the prediction in the badge with a visually-distinct shape so the user knows "guess" vs "decision," and the existing keystrokes become implicit corrections without any new UI.
- **Extend `/thread` for any per-row visual signal** rather than adding a parallel per-row HTTP call. The plugin already calls `/thread` once per inbox row; adding fields to its JOIN is cheap, and the existing `_threadStateCache` (30s TTL) absorbs it. A second HTTP call per row would double-render and flicker.
- **Share the rating palette via `rating-colors.js`** if you need to render 1–9 colored elements elsewhere — both `person-band.jsx` and `rating-suggestion-chip.jsx` consume it, so updates stay consistent.
- **Test idempotence on anything that writes to the warehouse.** Re-running should be a no-op or skip cleanly.
- **APFS-clone backup before bulk writes** from CLI tools. `cp -c warehouse.sqlite warehouse.sqlite.pre-<thing>-<ISO>`. Auto-triggered hooks (like `/intake-now`) skip the backup — they're too frequent for it.
- **Localhost only.** Tailscale exposure is a deferred phase. Don't bind 0.0.0.0.
- **Append-only on rating values; in-place on cosmetic metadata.** If you're tempted to UPDATE a rating, stop and add a new row instead.
- **The CSV is the user surface. The warehouse mirrors it.** When a contact's rating changes via auto-rule or manual tag, the CSV gets updated atomically. Don't drift.
- **Path handling.** Always lowercase emails on insert. Always percent-encode SQLite URIs. Never silently rewrite paths.
- **Mind the macOS keystroke remaps.** `Option+digit` produces typographic chars. `Cmd+Option+D` toggles the Dock. `Cmd+Shift+3/4` are screenshots. Dictation tools that capture Control globally (Wispr Flow and similar) eat bare Ctrl chords. When in doubt, paste a `keydown` listener into DevTools and confirm what the OS lets through.

## Quick health check

Run these any time something feels off:

```bash
# Sidecar alive?
launchctl list | grep com.mml.classifier
curl -sS http://127.0.0.1:8765/healthz | python3 -m json.tool

# Three workers running? (proves Phase 4.5 + 5.5.2 + 6.0 are alive)
tail -n 50 /tmp/mml-sidecar.log | grep -E 'routing-worker|cluster-worker|rating-worker'

# Plugin loaded?
ls -laL ~/Library/Application\ Support/Mailspring/packages/mml-engagement-spike/lib/

# Warehouse fresh? ($REPO is your clone of this template)
sqlite3 "$REPO/warehouse.sqlite" \
  "SELECT COUNT(*) AS messages, MAX(received_date) AS latest FROM messages;"

# Current routing prompt version?
cat "$REPO/services/mml-classifier/mml_classifier/prompts/CURRENT_VERSION.txt"

# Per-classifier coverage?
sqlite3 "$REPO/warehouse.sqlite" "
  SELECT 'routing'  AS k, classifier_version, COUNT(DISTINCT message_id)
  FROM routing_suggestions GROUP BY classifier_version
  UNION ALL
  SELECT 'rating',  classifier_version, COUNT(DISTINCT message_id)
  FROM rating_suggestions GROUP BY classifier_version
  UNION ALL
  SELECT 'cluster', 'phase2_email', COUNT(DISTINCT message_id)
  FROM message_classifications WHERE source='phase2_email';
"

# Recent /thread traffic?
tail -n 20 ~/Library/Logs/mml-classifier/stderr.log
```

If sidecar is down (launchd path): `launchctl kickstart -k gui/$(id -u)/com.mml.classifier`. If running manually:

```bash
kill $(lsof -nP -tiTCP:8765 -sTCP:LISTEN)
cd "$REPO/services/mml-classifier"
nohup .venv/bin/python -m mml_classifier.server > /tmp/mml-sidecar.log 2>&1 &
disown
```

If plugin is broken: open Mailspring → `Cmd+Option+I` → Console tab → look for `[mml-productivity]` errors. The first `[mml-productivity] accept-suggestion ready` / `auto-intake: listening` / `registered 11 routed commands` lines tell you activate() ran clean.

If warehouse is stale: it shouldn't be — auto-intake fires on every persist. Manually nudge with `python -m mml_classifier.mailspring_intake --commit` or `curl -sS -X POST http://127.0.0.1:8765/intake-now -H 'Content-Type: application/json' -d '{}'`.
