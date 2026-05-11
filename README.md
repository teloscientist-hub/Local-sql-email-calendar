# MML Productivity — template

> A local-first, person-centric email triage system. Mailspring plugin paints a colored badge on each inbox row so you can triage by *relationship importance* instead of by date. SQLite warehouse + Python sidecar + LLM scoring. No cloud.

This is a **template repo**. It contains the architecture, schema, scripts, plugin, and docs needed to build the system for *your own* email and contacts. Nothing personal is included — you bring your own data.

## What it does

- **Reads** your local Mailspring mail cache (`edgehill.db`).
- **Normalizes** every message + contact into a SQLite warehouse you own.
- **Classifies** each message into one of 31 clusters (newsletters, family, clients, etc.) using a local LLM.
- **Rates** each sender 1–9 by relationship importance — driven by a CSV you maintain by hand.
- **Renders** a colored pill in Mailspring's thread list per row, plus a TLDR overlay for borderline newsletters.
- **Captures** quick keystroke ratings (`Ctrl+Cmd+0..9`) and notes (`Ctrl+Cmd+N`) directly inside Mailspring.

The result: an inbox where the most important relationships visually pop without needing folders, filters, or unread counts.

## Who it's for

Someone who:
- Uses (or is willing to use) Mailspring as their email client.
- Has a non-trivial inbox (years of history, hundreds of correspondents) and is tired of date-ordered triage.
- Is comfortable running a Python service and editing TypeScript/JSX.
- Wants the data on their own machine, not in someone's cloud.

## Architecture in 30 seconds

```
Mailspring  ──reads──▶  edgehill.db  (mail cache, bronze)
    │
    │ MML plugin renders badges, captures ratings/notes
    ▼
sidecar (Python, localhost:8765)  ◀──HTTP──  plugin
    │
    │ reads / writes
    ▼
warehouse.sqlite  (silver: messages, contacts, ratings, classifications, scores)
    ▲
    │ one-shot intake CLI pulls new messages from edgehill.db
    │
contacts_to_rate.csv  (gold: your hand-curated 1–9 per sender)
```

Full architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repo layout

```
.
├── docs/             ← architecture, build guide, API notes, taxonomy
├── migrations/       ← SQL schema + migration scripts for the warehouse
├── pipeline/         ← legacy-mail (PST/mbox) ingest scripts
├── services/         ← Python sidecar (HTTP, classifier, intake)
├── plugin/           ← Mailspring plugin (TypeScript/JSX)
├── tools/            ← audit + dump utilities
├── templates/        ← starter files you copy → fill in → keep out of git
├── README.md         ← this file
├── SETUP.md          ← step-by-step bring-up
└── LICENSE
```

## Quick start

See [`SETUP.md`](SETUP.md) for the full walkthrough. The short version:

1. Clone this repo.
2. Install Mailspring; symlink the `plugin/` directory into Mailspring's package dir.
3. `cd services && python -m venv .venv && .venv/bin/pip install -e .`
4. Initialize the warehouse: `sqlite3 warehouse.sqlite < migrations/00_warehouse_schema.sql`.
5. Copy `templates/contacts_to_rate.template.csv` → `contacts_to_rate.csv` and start filling in ratings.
6. Run the sidecar (manually for now): `cd services && .venv/bin/python -m mml_classifier.server`.
7. Open Mailspring. Badges should appear once you've rated a few senders and ingested some mail.

## What it is not

- Not a SaaS. No telemetry, no cloud calls (the LLM is a local CLI).
- Not a Mailspring fork — it's a regular Mailspring plugin plus an out-of-process sidecar.
- Not multi-user. The whole design assumes one inbox, one user.
- Not finished — the upstream project is mid-build. See [`docs/FUTURE_IMPROVEMENTS.md`](docs/FUTURE_IMPROVEMENTS.md).

## Lineage

This is the template extracted from a working personal system named "MML Productivity," built incrementally over a series of phases. The original system has been running on one user's mail since early 2026. Personal data, hand-curated ratings, and per-user content are excluded from this template; the schema, code, scripts, and architectural patterns are preserved.

If you adopt this and customize it heavily, you may want to rename the `mml_classifier` Python package, the `com.mml.classifier` launchd label, and the `MML_*` env-var prefix to something of your own. Search/replace those strings is the rename script.

## License

MIT — see [`LICENSE`](LICENSE).
