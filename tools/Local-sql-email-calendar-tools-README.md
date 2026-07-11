# tools/ — audit and conversion utilities

Standalone scripts that operate on the warehouse and/or external files. Not part of the runtime — run by hand when you need them.

| Script | Purpose |
|---|---|
| `dump_rated_contacts.py` | Generates a Markdown audit doc of all rated contacts, with send/receive counts joined against the warehouse. Useful for spot-checking the CSV. |
| `dump_rated_contacts_xlsx.py` | Same audit, but as a spreadsheet for filtering/sorting in Excel/Numbers. |
| `parse_rwz.py` | Parses Outlook 2007-vintage `.rwz` (rules export) files into JSON. Useful when migrating old Outlook rule sets into Mailspring's rules engine. Tolerant of legacy rule types. |

## Running

```sh
.venv/bin/python tools/dump_rated_contacts.py \
    warehouse.sqlite contacts_to_rate.csv > RATED_CONTACTS_AUDIT.md

.venv/bin/python tools/dump_rated_contacts_xlsx.py \
    warehouse.sqlite contacts_to_rate.csv RATED_CONTACTS_AUDIT.xlsx

.venv/bin/python tools/parse_rwz.py path/to/your_rules.rwz > rules.json
```

Both audit outputs are `.gitignore`'d — they contain personal contact data.
