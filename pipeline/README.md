# pipeline/ — PST → warehouse ingest scripts

One-shot scripts for the **initial backfill** of historical mail from PST or mbox sources into the warehouse. You run these **once per source archive**, in roughly the order below. Once your warehouse is populated, the Mailspring intake CLI (in `services/mml-classifier/mml_classifier/mailspring_intake.py`) takes over for ongoing ingest from Mailspring's live `edgehill.db`.

## Prereqs

- A populated `me_addresses` table in your warehouse, or a file at the path pointed to by `$OWNER_ADDRS_FILE` listing one address per line. **Each pipeline script needs to know which addresses are yours so it can distinguish "you sent" from "someone else sent."**
- For PST imports: install `pypff` (`pip install libpff-python`) for the pypff path, or `readpst` (`brew install libpst`) for the readpst path.
- An initialized warehouse: `sqlite3 warehouse.sqlite < migrations/00_warehouse_schema.sql`.

## Filling in your owner addresses

Several scripts have `OWNER_DOMAINS = set()` / `OWNER_ADDRS = set()` at the top — placeholders. Two ways to fill them in:

1. **Edit-in-place**: paste your domains and addresses into the sets at the top of each script. Fastest if you're running these once.
2. **Load from a file**: replace the hardcoded sets with `OWNER_ADDRS = set(open(os.environ['OWNER_ADDRS_FILE']).read().splitlines())` and keep your addresses in `me_addresses.txt` (which is `.gitignore`'d so it never leaks).

Use whichever fits your workflow. The template ships with empty sets so nothing personal is committed.

## The scripts

| # | Script | Purpose |
|---|---|---|
| 0 | `00_probe_pst.py` | Diagnostic. Opens a PST and reports how much pypff can read. Useful for sizing the ingest. |
| 1 | `01_ingest_pypff_walk.py` | Tier-1 ingest: walks the PST's folder hierarchy via pypff and inserts every message. |
| 1b | `pst_to_sqlite.py` | Alternative ingest path using `readpst` (libpst CLI). Higher fidelity for some PSTs. |
| 2 | `backfill_html_rtf.py` | Re-walks a PST to fill in `body_html` / `body_rtf` for messages that came in plain-text-only. |
| 3 | `reimport_sent_native.py` | Re-imports a Sent folder, extracting recipient emails from quoted reply bodies when the original recipient was display-name-only. |
| 4 | `build_contact_lookup.py` | Builds a `name → list-of-emails` JSON lookup from PST Contacts folders + observed sender history. |
| 5 | `fill_name_only.py` | Uses the lookup JSON to backfill `recipients.addr` for rows where `addr` is NULL but `name` is set. |
| 6 | `resolve_nameonly_from_body.py` | Last-resort: scans the quoted body of each message for `From:` / `To:` lines containing the recipient's name and an email. |
| 7 | `build_entities.py` | Builds the person/email mapping (`contact_entities` + `contact_email_map`) from sender history + lookup JSON. Conservative — only links emails to a person when the link is specific. |
| 8 | `rebuild_contacts_csv.py` | Aggregates send/receive counts across all of a person's addresses and writes `contacts_to_rate.csv` (the user-facing rating list, sorted by an interaction score). |
| 8.5 | `pst_contacts_intake.py` | Imports rich PST contact metadata (organization, title, web page, file-as, phones, addresses, group memberships) from a contacts-only PST into `pst_contact_meta` and related tables. Idempotent via sha1 item-key. Run from `services/mml-classifier/mml_classifier/`. |
| — | `ingest_mbox.py` | Ingests messages from an mbox file (or Google Takeout `.mbox`) into the warehouse. Idempotent by Message-ID. Dry-run by default; pass `--commit`. |
| — | `ingest_imap.py` | Thin IMAP→local-mbox fetcher. Connects to an IMAP server, dumps a folder to a local `.mbox`, then you run `ingest_mbox.py` on the result. Does not write to the warehouse directly. |

## Typical run order

Assuming a single PST source:

```sh
# 0. Probe (optional, informational)
.venv/bin/python pipeline/00_probe_pst.py /path/to/source.pst

# 1. Initial ingest
.venv/bin/python pipeline/01_ingest_pypff_walk.py /path/to/source.pst warehouse.sqlite
# (or pst_to_sqlite.py for the readpst path)

# 2. Backfill HTML/RTF bodies (one PST at a time, source-id from the row inserted above)
.venv/bin/python pipeline/backfill_html_rtf.py warehouse.sqlite 1 /path/to/source.pst

# 3. Reimport Sent items so recipient emails are recovered from quoted bodies
.venv/bin/python pipeline/reimport_sent_native.py warehouse.sqlite /path/to/source.pst 1

# 4. Contact lookup (name → emails)
.venv/bin/python pipeline/build_contact_lookup.py \
    /path/to/source.pst warehouse.sqlite contact_lookup.json

# 5. Backfill recipient addresses
.venv/bin/python pipeline/fill_name_only.py warehouse.sqlite contact_lookup.json

# 6. Last-resort body scanning
.venv/bin/python pipeline/resolve_nameonly_from_body.py warehouse.sqlite

# 7. Build contact entities
.venv/bin/python pipeline/build_entities.py warehouse.sqlite contact_lookup.json

# 8. Rebuild the ratings CSV (preserves any existing ratings)
.venv/bin/python pipeline/rebuild_contacts_csv.py \
    warehouse.sqlite contacts_to_rate.csv contacts_to_rate.csv.new
mv contacts_to_rate.csv.new contacts_to_rate.csv

# 8.5 Import rich PST contact metadata (phones / addresses / org / title)
#     and folder→group mappings. Idempotent (sha1 item-key); dry-run by default.
.venv/bin/python -m mml_classifier.pst_contacts_intake \
    --pst /path/to/contacts.pst --db warehouse.sqlite
# Review the printed calibration sample + planned counts, then:
.venv/bin/python -m mml_classifier.pst_contacts_intake \
    --pst /path/to/contacts.pst --db warehouse.sqlite --commit
```

## Multiple sources

For each additional PST, repeat steps 1–3 (ingest, backfill, sent-reimport) with the new PST and a new `pst_source_id`. Then re-run 4–8 once at the end with all source PSTs as arguments.

## What these scripts don't do

- They don't classify messages (that's the sidecar's job, post-ingest).
- They don't score message importance (sidecar, post-ingest).
- They don't populate `me_addresses` — you do that by hand, or by running the candidate-generation step in `migrations/HISTORY.md` Phase 0.
- They don't run idempotently. If you re-run an ingest with the same PST, you'll get duplicates. Wipe the relevant `pst_source_id`'s rows first if you need to retry.
