# templates/

Starter files. Copy each one to its non-`.template` name, fill in your own values, and **do NOT commit the populated versions** — every template file's non-`.template` counterpart is `.gitignore`'d.

| Template | Copy to | Purpose |
|---|---|---|
| `contacts_to_rate.template.csv` | `<repo-root>/contacts_to_rate.csv` | Your master rating list. Pipeline scripts and the sidecar both look for this at the repo root. |
| `me_addresses.template.txt` | `<repo-root>/me_addresses.txt` | Your sending addresses, one per line. Used to populate the `me_addresses` table and (optionally) to seed `OWNER_ADDRS` in pipeline scripts. |
| `priority_friends.template.md` | `<repo-root>/priority_friends.md` | List of "never miss" people. Includes SQL snippets to set the priority_friend flag in `sender_classifications`. |
| `.env.template` | `<repo-root>/.env` | Environment overrides for the sidecar's config (paths, ports, model). Optional — defaults are fine for most installs. |
| `mailspring_rules.template.json` | `<repo-root>/mailspring_rules.json` (or anywhere you keep it) | Example structure for the JSON file consumed by the Mailspring rules-import recipe. |

## Why templates aren't just empty files

Each template has 2–3 obviously-synthetic rows / examples so you can see the shape without inventing it from prose docs. The fake names (`Alex Example`, `you@example.com`, `Pat`, `Sam`) are chosen to be obviously placeholder and trigger zero confusion about whether they belong in your real list.

Delete the example rows before committing — wait, scratch that, you're not committing this, it's `.gitignore`'d. **Replace** the example rows with your own and save.
