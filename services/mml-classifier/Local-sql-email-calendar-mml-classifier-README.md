# mml-classifier

Phase 2 sidecar for the MML Productivity local-first email system. Reads the warehouse, scores fall-through messages (clusters 29 newsletters / 30 transactional / 31 cold inbound) via the local `claude` CLI, writes append-only rows to `content_scores`, and exposes a localhost HTTP endpoint that the Mailspring plugin queries for per-thread `(rating, cluster, importance_score, tldr_text)`.

## Layout

```
mml_classifier/        — package
  config.py            — paths, port, fall-through cluster IDs, versions, threshold
  db.py                — sqlite3 connection helpers (read-mostly, append-only writes)
  claude_cli.py        — subprocess wrapper around `claude --print --output-format json`
  ratings.py           — contacts_to_rate.csv loader + effective_rating() per RATING_SCALE.md
  thread_lookup.py     — RFC-822 Message-IDs → warehouse rows → aggregate ThreadState
  content_scorer.py    — pull candidates, call Claude, INSERT content_scores rows
  server.py            — stdlib http.server: GET /thread, POST /score-now, GET /healthz
  backfill.py          — CLI: --mode=recent --hours=72 | --mode=historical
  prompts/
    content_score_v1.md — system prompt for body→importance+tldr
tests/                 — pytest smoke + ratings tests
launchd/com.mml.classifier.plist
```

## Setup (one-time)

```bash
cd "services/mml-classifier"
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[test]   # zero runtime deps; test deps optional
```

The default HTTP transport is stdlib (`http.server`). FastAPI is an optional extra (`pip install -e .[fastapi]`); the FastAPI server is not built in v0.1.

## Run

```bash
# 1. Smoke-test the claude CLI wrapper
python -m mml_classifier.claude_cli --smoke

# 2. Score the most recent 72h of fall-through messages (calibration pass)
python -m mml_classifier.backfill --mode=recent --hours=72

# 3. Start the HTTP server (default 127.0.0.1:8765)
python -m mml_classifier.server

# 4. Historical backfill (long-running; resumable)
python -m mml_classifier.backfill --mode=historical
```

## launchd

```bash
cp launchd/com.mml.classifier.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mml.classifier.plist
launchctl list | grep com.mml.classifier
```

Logs land in `~/Library/Logs/mml-classifier/{stdout,stderr}.log`.

## HTTP contract

| Method | Path | Description |
|---|---|---|
| `GET` | `/thread?ids=<msgid1>,<msgid2>,...` | RFC-822 Message-IDs, URL-encoded, comma-joined. Returns aggregate ThreadState. |
| `POST` | `/score-now` | Body: `{"message_ids": [int]}` (warehouse PKs). Synchronous; for plugin's visible-thread on-demand scoring. |
| `GET` | `/healthz` | `{version, last_score_at, claude_cli_ok}` |

All endpoints return `200 OK` with nullable fields rather than 4xx/5xx for missing data. The plugin treats sidecar-down as "no badge" — silent fail.

## Notes

- Fall-through cluster IDs `{29, 30, 31}` are hardcoded in `config.py`. The 38-cluster v2 doc bumped #38 = "Needs Review" but the `cluster_definitions` table still has `CHECK BETWEEN 1 AND 31`; revisit when the schema accepts the v2 range.
- The sidecar invokes `claude --bare --no-session-persistence` to keep mail-scoring runs out of your interactive session history and auto-memory.
- Append-only writes to `content_scores`. Re-scoring inserts a new row; the latest wins via `(message_id, scored_at DESC)` index.
