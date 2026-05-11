# Integrations — third-party services wired into MML Productivity

> Optional add-ons that build on the core pipeline. Each section is self-contained: prerequisites, one-time setup, daily use, and gotchas. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`BUILD_GUIDE.md`](BUILD_GUIDE.md) first if you haven't.

---

## Google Calendar event creation from Mailspring email

> Press a keystroke on a focused email → LLM-drafted Google Calendar event in an overlay → review/edit → submit → event is created and mirrored into the warehouse linked to the source message.

### What it gives you

While reading any email in Mailspring, press **Ctrl+Cmd+E**. An overlay opens with an LLM-drafted Google Calendar event (title, time, duration, description, attendees pulled from the email's To/From with deselect checkboxes). Review, edit, ⌘+Enter — the event is created in Google Calendar and a row mirrors into `warehouse.calendar_events` linked back to `source_message_id`.

Rating/prioritization stays purely on the email side; the calendar is just an organizer. Single Google account at v1; multi-account is a Phase 2 extension.

### Architecture

```
Mailspring focused email
  → Ctrl+Cmd+E  (event-keystroke-handler.js)
  → vanilla-DOM overlay opens immediately with "Drafting…" state
  → POST /draft-event {rfc_message_id}          (30s timeout)
       sidecar resolves RFC→PK, loads body+participants,
       calls the LLM with prompts/draft_event_v1.md
  → fields populate; user edits
  → POST /create-event {…}                       (10s timeout)
       sidecar OAuth2 → googleapiclient → events.insert
       INSERT INTO calendar_events linking back to messages.id
  → overlay shows GCal htmlLink briefly, dismisses
```

Two HTTP endpoints, not one. The first is read-only (no Google API call); the second is the only call that writes. Splitting them lets the user always approve before the side effect.

### Files

**Sidecar (Python):**
- `services/mml-classifier/mml_classifier/gcal_oauth.py` — token load + refresh
- `services/mml-classifier/mml_classifier/gcal_oauth_setup.py` — one-time consent CLI
- `services/mml-classifier/mml_classifier/gcal_client.py` — googleapiclient wrapper
- `services/mml-classifier/mml_classifier/event_drafter.py` — LLM draft via `claude_cli.call`
- `services/mml-classifier/mml_classifier/event_creator.py` — GCal `events.insert` + warehouse mirror
- `services/mml-classifier/mml_classifier/prompts/draft_event_v1.md` — LLM system prompt
- Tests: `tests/test_event_drafter.py` (mocks the LLM), `tests/test_event_creator.py` (mocks `gcal_client.insert_event`)

**Plugin (Mailspring):**
- `plugin/src/event-keystroke-handler.js` — `Ctrl+Cmd+E` command
- `plugin/src/event-input-overlay.jsx` — vanilla-DOM overlay (no react-dom — Mailspring's sandbox doesn't expose it)
- `plugin/keymaps/mml-events.json` — chord registration

**Schema:**
- `migrations/05_warehouse_calendar.sql` — `calendars`, `calendar_events` tables + indices

**Config (env-var overridable, defaults in `config.py`):**
- `MML_CLASSIFIER_GCAL_CLIENT_SECRETS_PATH` → `<repo>/gcal_client_secrets.json`
- `MML_CLASSIFIER_GCAL_TOKEN_PATH` → `<repo>/gcal_token.json`
- `MML_CLASSIFIER_GCAL_GOOGLE_ACCOUNT` → your primary Google account
- `MML_CLASSIFIER_GCAL_TIMEZONE` → e.g. `America/Los_Angeles`

**Python dependencies (added to `pyproject.toml`):**
- `google-api-python-client>=2.100.0`
- `google-auth>=2.25.0`
- `google-auth-oauthlib>=1.2.0`

---

### One-time setup

#### 1. Google Cloud project + OAuth client

1. Visit https://console.cloud.google.com/ and either pick an existing project or create one. Note the **Project number** (you'll see it in error messages later).
2. **APIs & Services → Library → Google Calendar API → Enable.** *Don't skip this.* It's a separate step from creating the OAuth client; if you forget, the first `gcal_oauth_setup` run will fail with `403 accessNotConfigured` after you've already consented.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Desktop app.** Not Chrome extension, not web — the sidecar uses `google_auth_oauthlib.flow.InstalledAppFlow.run_local_server()`, the canonical Python desktop flow (spins up a localhost HTTP listener, browser redirects back to it after consent).
   - Name it whatever you want (e.g. "MML Productivity sidecar").
4. **Click "Download JSON"** on the post-creation dialog *before closing it*. Google's secret is unrecoverable once that dialog is dismissed.
5. **Rename the downloaded file** from `client_secret_*.json` to `gcal_client_secrets.json` and place it at `<repo>/gcal_client_secrets.json` (the path the sidecar's `config.py` looks for; it's in `.gitignore`).
6. **OAuth consent screen → Audience tab → Test users → + Add users → your Google account email.** Required because the app is in "Testing" mode (not published) — without listing yourself as a test user, the consent flow returns "access blocked."

#### 2. Warehouse migration

```bash
cd <repo>
cp -c warehouse.sqlite "warehouse.sqlite.pre-calendar-$(date +%Y%m%d)"
sqlite3 warehouse.sqlite < migrations/05_warehouse_calendar.sql
sqlite3 warehouse.sqlite \
  "SELECT name FROM sqlite_master WHERE name IN ('calendars','calendar_events') OR name LIKE 'idx_calendar%' ORDER BY name;"
```

The migration is idempotent (`CREATE TABLE IF NOT EXISTS`); re-runs are safe. The APFS clone (`cp -c`) is instant and free on macOS; on Linux substitute `cp --reflink=auto`.

#### 3. Install Python deps + run consent

```bash
cd <repo>/services/mml-classifier
.venv/bin/python -m pip install -e .
.venv/bin/python -m mml_classifier.gcal_oauth_setup
```

A browser will pop open with Google's consent screen. You'll see a **"Google hasn't verified this app"** warning — that's expected for an unverified personal-use OAuth client. Click **Advanced → Go to <app-name> (unsafe)** and grant the requested scopes (`calendar.events` + `calendar.readonly`).

The CLI's local HTTP listener captures the auth code, exchanges it for tokens (with a `refresh_token` for silent refresh), writes `<repo>/gcal_token.json`, then calls `calendarList.list()` and seeds a row in `calendars` for your primary calendar with `is_default = 1`.

#### 4. Reload the Mailspring plugin

If you haven't built the plugin in this session, run `cd plugin && npx tsc` to compile `src/` → `lib/`. Then in Mailspring: `Cmd+Option+I` → Console → `AppEnv.reload()` (or fully quit + relaunch).

---

### Daily use

- **Ctrl+Cmd+E** on a focused thread → overlay opens with "Drafting…" → fields populate within a few seconds → review → ⌘+Enter to create, **Esc** to cancel.
- **Uncheck attendees** you don't want invited before submitting (CC lists can be large).
- **Edit any field.** The LLM draft is a starting point; the form is fully editable.
- If the LLM call fails (sidecar down, LLM CLI error, timeout), the overlay falls back to a blank form with a "draft unavailable — fill in manually" hint; you can still create the event by typing.

### Verify it's working

```bash
# Sidecar sees the gcal config
curl -sS http://127.0.0.1:8765/healthz | python3 -m json.tool
# Look for the "gcal" object: token_present:true, valid:true (post-refresh)

# Default calendar is seeded
sqlite3 <repo>/warehouse.sqlite \
  "SELECT id, google_account, gcal_calendar_id, display_name, is_default FROM calendars;"

# After creating an event, the warehouse row appears
sqlite3 <repo>/warehouse.sqlite \
  "SELECT id, source_message_id, gcal_event_id, title, start_iso FROM calendar_events ORDER BY id DESC LIMIT 5;"
```

You can also smoke-test the endpoints directly without going through Mailspring:

```bash
# Draft-only (no GCal side effect; just exercises the LLM call)
curl -sS -X POST http://127.0.0.1:8765/draft-event \
  -H 'Content-Type: application/json' \
  -d '{"rfc_message_id":"<a-known-rfc-id-from-your-warehouse>"}' | python3 -m json.tool

# End-to-end (creates a real GCal event — clean up after)
curl -sS -X POST http://127.0.0.1:8765/create-event \
  -H 'Content-Type: application/json' \
  -d '{"title":"test","start_iso":"2026-05-12T10:00:00-07:00","duration_minutes":30,"attendees":[]}' \
  | python3 -m json.tool
```

### Gotchas to remember

- **Two prerequisites are easy to miss before running the setup CLI:**
  - Enabling the Calendar API on the project (separate from creating the OAuth client).
  - Adding yourself as a test user in the OAuth consent screen Audience tab (separate from creating the consent screen itself).

  Either one missing produces a clear error on first use, but both are easy to skip during the click-through.

- **Google's downloaded filename is `client_secret_<project>-<id>.apps.googleusercontent.com.json`.** The sidecar expects exactly `<repo>/gcal_client_secrets.json` — rename on save.

- **The unverified-app warning at consent time is expected.** Click Advanced → Go to (unsafe). The app is "unverified" because it's a personal-use OAuth client, not because anything is wrong with it. Publishing for verification only matters if other people will use the same client.

- **Token refresh is silent.** If you ever see a `GcalAuthError` in the sidecar logs, the refresh failed — re-run `gcal_oauth_setup` to re-consent. This is rare; refresh tokens don't expire unless revoked or unused for 6+ months.

- **The token file holds calendar-write access.** It's in `.gitignore` and should never be committed or shared. Treat it like a password.

- **The plugin makes two HTTP calls per event creation.** If you see the overlay populate but submit fails with a sidecar-down message, check `tail -f ~/Library/Logs/mml-classifier/stderr.log` to see whether the issue is `/draft-event` or `/create-event`.

### Extending

**Multi-account.** Add per-account rows to `calendars`, surface an account picker in the overlay, and either run `gcal_oauth_setup` per account or maintain a `gcal_token_<account>.json` per row. The schema already supports it (the `calendars.google_account` column).

**Calendar selection.** Add a dropdown in the overlay populated from `SELECT id, display_name FROM calendars WHERE NOT tombstone`. Pass the chosen `calendar_pk` in the `/create-event` payload (the sidecar already accepts it).

**Reverse sync.** Add a periodic task that calls `events.list()` on each tracked calendar and upserts into `calendar_events`. Enables pre-meeting briefings, "events on this thread" surfaces, etc.

**Visual indicator on the email.** Add a small icon to `EngagementBadge` rendering when `EXISTS (SELECT 1 FROM calendar_events WHERE source_message_id = m.id)`.

**Different calendar service.** The architecture is service-agnostic from `event_creator.py` upward — swap `gcal_client.py` for an iCloud/CalDAV client, keep everything else.

---

## Adding more integrations

Future integrations (Linear, Slack, Notion, etc.) follow the same pattern:

1. **OAuth or API key** lives in a gitignored credentials file under `<repo>/`.
2. **Sidecar module** wraps the third-party API; nothing else imports the third-party SDK.
3. **Two endpoints** per write-flow: a read-only draft endpoint, then a write endpoint the user explicitly approves.
4. **Mirror table** in the warehouse links the new entity back to `messages.id` (or `contact_entities.id`) for cross-reference.
5. **Plugin keystroke** opens an overlay analogous to the event-input overlay — keep it vanilla-DOM, no react-dom.

Each new integration gets its own section in this file with the same shape.
