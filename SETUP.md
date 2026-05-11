# SETUP — bringing up MML Productivity from this template

> The fastest path from a fresh clone to a fully-running system in your Mailspring inbox. ~2–3 hours if you know your way around Python + macOS launchd; up to a day if not (most of the time is just waiting for the historical-mail ingest in Phase 2).

For background and "why each choice" reasoning, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before starting; [`docs/BUILD_GUIDE.md`](docs/BUILD_GUIDE.md) walks through the same phases in narrative form.

---

## Phase 0 — Prerequisites

- **macOS** (the launchd plist + APFS-clone backups assume macOS; Linux works with `systemd` + `cp --reflink` substitutions but isn't tested).
- **Python 3.11+** and **Node 18+** with `npm`.
- **Mailspring 1.21+** installed and configured against your real email accounts (`brew install --cask mailspring`).
- An LLM CLI named `claude` on your `PATH` (Anthropic's official CLI, under Claude Max OAuth) **OR** override `MML_CLASSIFIER_CLAUDE_CLI` in `.env` to point at any CLI that takes a prompt on stdin and prints JSON on stdout.
- A **Google Cloud project** with Calendar API + OAuth desktop credentials (Phase 11 only — skip if you won't use the calendar feature).

---

## Phase 1 — Warehouse foundation

```sh
git clone <this-template> mml-productivity
cd mml-productivity

# Bootstrap personal-data files from templates (all gitignored)
cp templates/contacts_to_rate.template.csv contacts_to_rate.csv
cp templates/priority_friends.template.md priority_friends.md
cp templates/.env.template .env

# Edit .env if you need to override defaults (paths, model, port).

# Apply schema (idempotent — `IF NOT EXISTS` throughout)
for m in migrations/*.sql; do
  echo "applying $m"
  sqlite3 warehouse.sqlite < "$m"
done

# Seed me_addresses with every email you receive mail at
sqlite3 warehouse.sqlite <<'SQL'
INSERT OR IGNORE INTO me_addresses (email, added_at) VALUES
  ('you@example.com', datetime('now')),
  ('you@work.example.com', datetime('now'));
SQL

# Sanity check
sqlite3 warehouse.sqlite "SELECT email FROM me_addresses;"
sqlite3 warehouse.sqlite "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;"
```

The `cluster_definitions` table stays empty for now — Phase 3 fills it from your own mail history.

---

## Phase 2 — Historical ingest (optional but recommended)

If you want the system to know your real correspondents from day one, run the PST / mbox / IMAP ingest pipeline. Skip if you'd rather go forward-only.

```sh
# Export from your archive provider:
#   - Outlook: export your archive as .pst (use the pipeline/parse_pst.py path)
#   - Gmail/IMAP: Google Takeout produces .mbox; or use the IMAP scripts
# Place the export at <repo-root>/raw/

# Run the ingest scripts in order (see pipeline/README.md for the full list)
python -m pipeline.ingest_pst        # or pipeline.ingest_mbox
python -m pipeline.build_entities    # de-dupe senders to contact_entities
python -m pipeline.rebuild_contacts_csv  # regenerate contacts_to_rate.csv

# Verify
sqlite3 warehouse.sqlite "SELECT COUNT(*) FROM messages;"
sqlite3 warehouse.sqlite "SELECT COUNT(*) FROM contact_entities;"
```

Time: 1–4 hours for ~100k messages. The warehouse can grow to several GB; `.gitignore` covers `*.sqlite`.

---

## Phase 3 — Taxonomy generator (build YOUR clusters)

Rather than ship a generic taxonomy that fits nobody, this template gives you a tool that proposes a per-deployment taxonomy from your own mail. Read [`docs/CLASSIFICATION_TAXONOMY.md`](docs/CLASSIFICATION_TAXONOMY.md) for the workflow.

```sh
# Propose a taxonomy from a stratified sample of your warehouse
python -m tools.taxonomy_generator --propose --sample 500 --years 5

# Review the draft
$EDITOR email_classification_instructions_universal.draft.md

# When satisfied, save as the live cluster doc
mv email_classification_instructions_universal.draft.md \
   email_classification_instructions_universal.md

# Populate cluster_definitions from the doc (manual SQL — example shape)
sqlite3 warehouse.sqlite <<'SQL'
INSERT INTO cluster_definitions (cluster_id, cluster_name, main_category,
                                 created_at, definition_version)
VALUES
  (1, 'Longtime friends', 'personal', datetime('now'), 'v1'),
  (3, 'Family',           'personal', datetime('now'), 'v1'),
  -- ... fill in the rest from your generated doc
  ;
SQL
```

Edit `services/mml-classifier/mml_classifier/ratings.py` `CLUSTER_DEFAULT_RATING` to map your cluster IDs to default 0–9 ratings.

---

## Phase 4 — Sidecar install

```sh
cd services/mml-classifier
python -m venv .venv
.venv/bin/pip install -e .

# Smoke-test
.venv/bin/python -m mml_classifier.server &
curl -sS http://127.0.0.1:8765/healthz | python3 -m json.tool
kill %1
```

For autostart via launchd:

```sh
# Copy template plist and edit absolute paths in it
cp launchd/com.mml.classifier.template.plist launchd/com.mml.classifier.plist
# Edit launchd/com.mml.classifier.plist — replace <REPLACE_*> tokens.

ln -s "$(pwd)/launchd/com.mml.classifier.plist" \
      ~/Library/LaunchAgents/com.mml.classifier.plist
launchctl load -w ~/Library/LaunchAgents/com.mml.classifier.plist
launchctl list | grep com.mml.classifier   # should show a PID
```

Logs live at `~/Library/Logs/mml-classifier/{stdout,stderr}.log`.

---

## Phase 5 — Mailspring plugin install

```sh
cd ../../plugin
# lib/ is committed, so the plugin runs without an npm install if you don't
# plan to edit src/. If you DO want to edit src/:
#   npm install && npx tsc

# Symlink into Mailspring's package directory
ln -s "$(pwd)" ~/Library/Application\ Support/Mailspring/packages/mml-productivity
```

Then in Mailspring:
1. Restart (`Cmd+Q`, re-open) OR press `Cmd+Option+L` to reload.
2. Open DevTools (`Cmd+Option+I`) → Console. Confirm `[mml-productivity] activate` and `[mml-productivity] registered N routed commands`.
3. Create the four disposition folders (`Pending/Waiting/Complete/Later`) and your `Routed/<name>` folders in each account (see [`docs/MAILSPRING_SETUP.md`](docs/MAILSPRING_SETUP.md) §3 for a DevTools snippet that does this).

---

## Phase 6 — Manual rating workflow

Open Mailspring → click a thread → press `Ctrl+Option+5` (or any other digit 0–9). The badge re-renders with the new color, and `message_ratings` gets a row. Press `Ctrl+Option+N` to add a free-text note explaining *why* (the LLM picks up notes as few-shot signal in Phase 8+).

```sh
# Verify
sqlite3 warehouse.sqlite "
  SELECT message_id, rating, note, rated_at
  FROM message_ratings ORDER BY id DESC LIMIT 5;"
```

Rate ~30 of your top correspondents by hand before moving on — this gives the LLM something to learn from in Phase 8.

---

## Phase 7 — Live intake auto-fires

Auto-intake runs without configuration: whenever Mailspring writes new messages to its local DB, the plugin debounces 5s and POSTs `/intake-now` to the sidecar. The sidecar dedups against the warehouse and enqueues new messages on all three classifier worker queues.

Trigger a manual intake the first time, then it self-sustains:

```sh
cd services/mml-classifier
.venv/bin/python -m mml_classifier.mailspring_intake --commit
```

Verify in the sidecar log: `routing-worker enqueued N messages`, `cluster-worker enqueued N messages`, etc.

---

## Phase 8 — Real-time classification

With the workers running and the cluster doc in place (from Phase 3), every new message gets classified within a few seconds of intake. Backfill historical messages:

```sh
cd services/mml-classifier
.venv/bin/python -m mml_classifier.cluster_classifier --backfill --limit 1000
.venv/bin/python -m mml_classifier.route_classifier   --backfill --limit 1000
.venv/bin/python -m mml_classifier.rating_classifier  --backfill --limit 1000
```

Cost: typically under $1 per 1000 messages with the Haiku default. Adjust `--limit` to budget.

---

## Phase 9 — Routing keystrokes + LLM acceptance

Open any inbox row → press `Cmd+Option+<letter>` (per your `keymaps/mml-routed.json`) to move the thread to a `Routed/<folder>`. The plugin logs the decision to `routing_corrections` as `manual`/`accept`/`override` depending on whether a cached LLM suggestion existed and matched.

Press `Cmd+Option+Y` instead to **accept** the LLM's suggestion for the focused thread. The plugin fetches `/route-suggest` on press; the first call per thread triggers a real Claude classification.

```sh
# Audit accept/override rates
sqlite3 warehouse.sqlite "
  SELECT source, COUNT(*) FROM routing_corrections
  GROUP BY source ORDER BY 2 DESC;"
```

---

## Phase 10 — Self-refinement (automatic)

After 25 net-new `routing_corrections` rows accumulate (configurable via `MML_CLASSIFIER_ROUTING_REFINEMENT_TRIGGER_COUNT`), the sidecar fires `prompt_refinement.refine()` automatically. Claude Sonnet reads the current routing prompt + the last 200 corrections, proposes anchor additions or definition refinements, and writes a new prompt version to disk + bumps `prompts/CURRENT_VERSION.txt`. See [`docs/PROMPT_REFINEMENT.md`](docs/PROMPT_REFINEMENT.md) for the loop's full design.

Watch it happen:

```sh
# Trigger a dry-run any time
python -m mml_classifier.prompt_refinement --dry-run

# Audit deployed versions
sqlite3 warehouse.sqlite "
  SELECT version, parent_version, deployed_at
  FROM routing_prompt_versions ORDER BY deployed_at DESC;"

# Rollback to the previous version
python -m mml_classifier.prompt_refinement --rollback
```

---

## Phase 11 — Calendar integration (optional)

If you want `Ctrl+Option+E` to draft Google Calendar events from email:

1. Create a Desktop OAuth client in Google Cloud Console with the Calendar API scope.
2. Download `client_secret_*.json` and save as `gcal_client_secrets.json` (gitignored) at the repo root.
3. Run the one-time consent flow:
   ```sh
   cd services/mml-classifier
   .venv/bin/python -m mml_classifier.gcal_oauth_setup
   ```
   This opens a browser, completes consent, writes `gcal_token.json`, and seeds the primary calendar in the warehouse.
4. Ingest your calendar history (optional but useful):
   ```sh
   .venv/bin/python -m mml_classifier.calendar_intake --commit --years 1
   ```

Now `Ctrl+Option+E` on any email pops the event-draft overlay.

---

## Phase 12 — Promote stable patterns to Mailspring rules

After a few weeks of corrections, mine `routing_corrections` for sender→folder patterns confirmed N times with no disagreements. These become candidates for Mailspring mail rules that bypass the LLM entirely:

```sh
python -m mml_classifier.promote_corrections --min-count 3
```

Outputs a printable table + a JSON snippet pasteable into Mailspring DevTools (`MailRules-V2` localStorage key). See [`docs/MAILSPRING_RULES_RECIPE.md`](docs/MAILSPRING_RULES_RECIPE.md) for the paste flow.

---

## What you'll want to write next

- A `LOCAL_README.md` (gitignored) capturing your specific config — addresses, custom cluster names, plist absolute paths. Use this when you forget how you set something up.
- Adjustments to `plugin/src/routed-keystroke-handler.js` `ROUTES` and `keymaps/mml-routed.json` if you renamed routing folders away from the working-system example.
- Eventually, custom workers or new badge layers — the existing patterns in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) "Building new features" section are the templates to copy.

---

## Where to look when stuck

- Plugin doesn't load → [`docs/MAILSPRING_SETUP.md`](docs/MAILSPRING_SETUP.md) troubleshooting.
- Plugin loads, no badges → check sidecar log, verify `/thread` traffic.
- Sidecar errors → `tail -f ~/Library/Logs/mml-classifier/stderr.log`.
- Architectural questions → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- "Why is it doing X?" → check the relevant phase in [`migrations/HISTORY.md`](migrations/HISTORY.md) and [`docs/BUILD_GUIDE.md`](docs/BUILD_GUIDE.md).
