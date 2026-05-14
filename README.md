# MML Productivity — template

> A local-first, person-centric email triage system. Mailspring plugin paints a colored badge on each inbox row so you can triage by *relationship importance* instead of by date. SQLite warehouse + Python sidecar + LLM scoring. No cloud.

This is a **template repo**. It contains the architecture, schema, scripts, plugin, and docs needed to build the system for *your own* email and contacts. Nothing personal is included — you bring your own data.

## What it does

- **Reads** your local Mailspring mail cache (`edgehill.db`) and your Google Calendar.
- **Normalizes** every message, contact, and calendar event into a SQLite warehouse you own.
- **Classifies** each message into one of 38 clusters (newsletters, family, clients, etc.) using a local LLM.
- **Routes** each message into one of 11 working folders (`Routed/AI`, `Routed/deals`, `Routed/Finance`, …) using a second LLM whose prompt **self-refines** from your overrides.
- **Rates** each message 0–9 for personal priority using a third LLM whose prompt also **self-refines** from your manual ratings.
- **Renders** a four-layer colored badge in Mailspring's thread list per row: filled pill (your rating), hex chip (LLM's guess), gray cluster tag, content marker dot.
- **Captures** keystroke ratings (`Ctrl+Option+0..9`), notes (`Ctrl+Option+N`), routing (`Cmd+Option+A/B/C/E/F/H/M/P/S/W/X`), accept-suggestion (`Cmd+Option+Y`), event creation from email (`Ctrl+Option+E`), and a native sort-view overlay (`Cmd+Option+V`).
- **Drafts** Google Calendar events from email content and writes them back to your real calendar.

The result: an inbox where the most important relationships visually pop, the LLM proposes a folder and a rating for every message, and the routing/rating prompts get better every time you correct them — all without leaving Mailspring.

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
    │ MML plugin renders 4-layer badge, captures ratings/notes/routing,
    │ drafts events, opens sort-view overlay
    ▼
sidecar (Python, localhost:8765)  ◀──HTTP──  plugin
    │     │
    │     ├── routing-worker  (LLM — self-refines)
    │     ├── rating-worker   (LLM — self-refines)
    │     └── cluster-worker  (LLM)
    │
    │ reads / writes
    ▼
warehouse.sqlite  (silver: messages, contacts, events, ratings,
                   classifications, routing decisions, prompt-version log)
    ▲                    ▲
    │                    │
    │           ┌────────┴────────┐
    │           │                 │
edgehill.db    Google Contacts   Google Calendar
(intake CLI)   (intake CLI)      (intake CLI + write-back)
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
├── KEYSTROKES.md     ← cheat sheet for all in-Mailspring keybindings
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
