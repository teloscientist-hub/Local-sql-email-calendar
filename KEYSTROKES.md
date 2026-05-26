# MML Productivity — Mailspring Keystrokes (one-sheet)

_Updated 2026-05-11. Print this. All keystrokes act on the currently focused thread (or the multi-selection if one exists)._

---

## Routing (move into a `Routed/` folder) — `Cmd+Option+<letter>`

| Keystroke | Folder | What lives there |
|---|---|---|
| **Cmd+Option+A** | `Routed/AI` | Machine learning, AI tools, AI integration into life & business |
| **Cmd+Option+B** | `Routed/deals` | Promo / discount / "buy now" from companies (pre-purchase) |
| **Cmd+Option+C** | `Routed/coach sales` | Marketing & training *to* coaches; sales-knowledge pitches |
| **Cmd+Option+E** | `Routed/entertaining` | Substantive-but-leisure reading; Substacks; humor; hobbies |
| **Cmd+Option+F** | `Routed/Finance` | Receipts, invoices, proof of purchase, money records (post-purchase) |
| **Cmd+Option+H** | `Routed/aol7` | Body / health — supplements, fitness, medical, hormone, sleep |
| **Cmd+Option+M** | `Routed/models` | Marketing-exemplar emails (hand-curated; LLM rarely auto-routes here) |
| **Cmd+Option+P** | `Routed/pol` | Political content (both sides); advocacy; campaign mail |
| **Cmd+Option+S** | `Routed/smm` | Social-media platform notifications (FB / LI / X / IG / TikTok etc.) |
| **Cmd+Option+W** | `Routed/Wellness` | Self-development; philosophy; psychology; ideas for becoming better |
| **Cmd+Option+X** | `Routed/Tech Noise` | High-volume technical noise — WordPress, platform notifications, automated churn |

## Confirm / override LLM suggestion

| Keystroke | What it does |
|---|---|
| **Cmd+Option+Y** | Open the routing-confirm overlay. Then: **Y** or **Enter** = accept the LLM's suggestion · any routing letter above = override · **N** (only if not yet classified) = classify now · **Esc** = cancel |

---

## Disposition (move into a top-level Processing folder) — `Cmd+Shift+<digit>` or `Cmd+Option+<digit>`

| Keystroke | Folder | Meaning |
|---|---|---|
| **Cmd+Shift+1** / **Cmd+Option+1** | `Pending` | Needs the owner's action; not yet started |
| **Cmd+Shift+2** / **Cmd+Option+2** | `Waiting` | the owner is awaiting someone else / external action |
| **Cmd+Shift+3** / **Cmd+Option+3** | `Complete` | Done; archived for reference |
| **Cmd+Shift+4** / **Cmd+Option+4** | `Fun` | (Top-level Processing/Fun, distinct from `Routed/entertaining`) |

_The `Cmd+Option+<digit>` alternates exist because **Cmd+Shift+3** and **Cmd+Shift+4** are also macOS screenshot shortcuts. The alts always work._

---

## Manual rating (0–9) — `Ctrl+Option+<digit>`

| Keystroke | Effect |
|---|---|
| **Ctrl+Option+0**…**9** | Tag the focused message with a manual 0–9 rating. Writes one row to `message_ratings` AND updates `contacts_to_rate.csv` for the sender (bare-tag upsert). Instant — no UI. Latest wins. |

_See `docs/RATING_SCALE.md` for what each number means._

---

## Add a note explaining a rating — `Ctrl+Option+N`

| Keystroke | Effect |
|---|---|
| **Ctrl+Option+N** | Open the note input overlay near the focused message. Type a reason / context → **Enter** to save. UPDATEs the `note` column on the latest `message_ratings` row for that message. The note becomes durable signal — it gets fed back to the rating LLM as a few-shot example on future classifications. **Esc** cancels. |

---

## Create a calendar event from an email — `Ctrl+Option+E`

| Keystroke | Effect |
|---|---|
| **Ctrl+Option+E** | Open event-input overlay. Sidecar drafts title / time / attendees from the email via LLM. Edit fields, submit → writes to Google Calendar AND mirrors into the warehouse (`events`, `event_attendees`, `event_changes`). **Esc** cancels. |

---

## Sort-view (sortable list of current perspective) — `Cmd+Option+V`

| Keystroke | Effect |
|---|---|
| **Cmd+Option+V** | Open a sortable list overlay of the threads currently in Mailspring's active view (Inbox, `Routed/AI`, search results, etc). Columns: Sender · Count (per-sender within view) · Engagement (lifetime send count) · To-addr · Subject · Date · Rate. Click any column header to re-sort; click again to flip direction. Click a row to open that thread (the overlay closes and Mailspring focuses it). **Esc** dismisses. Default sort: by sender name; multiple emails from the same sender are visually grouped. |

---

## Cheat-sheet by modifier

- **Cmd+Option** = ROUTING and accept-suggestion (letters + Y), plus SORT-VIEW (V).
- **Cmd+Shift** = DISPOSITION (digits 1–4, with Cmd+Option+digits as alts).
- **Ctrl+Option** = TAG rating (digits 0–9), add NOTE (N), create EVENT (E).

The three modifier prefixes never collide with each other. The three action surfaces — routing, disposition, rating — each have their own modifier family.

---

## macOS / Electron conflicts to know

| Combo | What macOS does | Our usage | Notes |
|---|---|---|---|
| Cmd+Shift+3 / 4 | Screenshot | Disposition 3 / 4 | Use the **Cmd+Option+3/4** alts. |
| Cmd+Option+D | Show/Hide Dock | Not used by us | Avoided. |
| Cmd+Option+H | Hide Others | `Routed/aol7` (this binding) | If aol7 routing doesn't fire, OS captured it — say so and we'll rebind to T or K. |
| Cmd+Option+W | Close All Windows | `Routed/Wellness` (this binding) | If a Mailspring window closes instead, we'll rebind. |
| Cmd+Option+I | Open DevTools (Electron) | Not used by us | Intentionally avoided. |
| Cmd+Option+L | Reload Mailspring | Not used by us | Useful to know — press it after plugin rebuilds. |
| Ctrl+anything | (Wispr Flow may intercept) | All Ctrl+Option bindings | If a tag/note/event keystroke doesn't fire, check Wispr's hotkey. |

---

## Quick checks if something doesn't work

```
# Sidecar healthy?
curl -sS http://127.0.0.1:8765/healthz | python3 -m json.tool

# Plugin loaded? Look for "[mml-productivity]" lines in Mailspring DevTools console.
# Open with Cmd+Option+I after launch.

# Current routing-prompt version
cat "services/mml-classifier/mml_classifier/prompts/CURRENT_VERSION.txt"
```
