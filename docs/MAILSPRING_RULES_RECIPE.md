# Mailspring rules import — recipe for converting legacy rules

> How to bring a large pre-existing rule set from another email client into Mailspring without retyping 36 rules by hand. The shape is provider-agnostic: extract → translate → apply via DevTools snippet.

If you have a fresh inbox with no legacy rules, skip this doc. Mailspring's native Mail Rules UI is fine for hand-authoring the few rules you'll write.

If you have **dozens** of rules from Outlook (`.rwz` export), Gmail filters (XML export), or another client — read on. The pattern is reusable.

## The three phases

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ 1. Extract           │    │ 2. Translate         │    │ 3. Apply             │
│                      │    │                      │    │                      │
│ Parse the legacy     │ ─▶ │ Map source actions   │ ─▶ │ Paste a DevTools     │
│ rule format into a   │    │ to Mailspring        │    │ snippet that calls   │
│ structured JSON dump │    │ template keys.       │    │ Actions.addMailRule  │
│                      │    │ Resolve folder paths │    │ per rule per account │
└──────────────────────┘    │ to live category IDs │    └──────────────────────┘
                            └──────────────────────┘
```

## Phase 1 — extract legacy rules into JSON

The output of this phase is a JSON file shaped like:

```json
[
  {
    "name": "Newsletters from publisher X (Outlook #1)",
    "conditionMode": "any",
    "conditions": [
      { "templateKey": "from", "comparatorKey": "contains", "value": "@publisherx.com" }
    ],
    "actions": [
      { "templateKey": "changeFolder", "value": "Routed/newsletters" }
    ],
    "disabled": false
  },
  ...
]
```

Note that `actions[].value` is a **folder PATH at extract time**. It gets resolved to a real category ID per account in phase 3.

### For Outlook .rwz files

This template ships [`tools/parse_rwz.py`](../tools/parse_rwz.py) — a tolerant parser for Outlook 2007-vintage `.rwz` exports. Run:

```sh
.venv/bin/python tools/parse_rwz.py your_outlook_rules.rwz > rules.json
```

The parser handles the rule types old Outlook actually uses (FROM-contains, SUBJECT-contains, SENT-TO, sender-display-name fallback, move-to-folder, move-copy, delete, forward, ...). Rule types it doesn't recognize land in an `unparsed` block at the top of the JSON for manual review.

### For Gmail filters

Gmail filters export as XML from `Settings → Filters and Blocked Addresses → Export`. Convert to the JSON shape above with a small adapter script — search for `gmail-filters-to-mailspring` on GitHub for prior art, or hand-craft 10 lines of Python.

### For other sources

The shape doesn't care where the rules came from. Any tool that emits an array of objects matching Mailspring's mail-rule schema (see [Mailspring rule docs](https://foundry376.github.io/Mailspring/) or grep `MailRulesProcessor` in the source) will work.

## Phase 2 — translate the action semantics

Mailspring's template keys you'll usually need:

| Template key | Use for |
|---|---|
| `changeFolder` | IMAP move-to-folder |
| `moveToLabel` | Gmail label-instead-of-move |
| `applyLabel` | Gmail tag-without-removing |
| `markAsRead` | Mark seen |
| `star` | Star the message |
| `markAsImportant` | Gmail "Important" marker |
| `moveToTrash` | Delete |
| `forward` | Forward to an address |
| `markAsSpam` | Mark as spam (use sparingly — provider trains on this) |

**Gotcha: Mailspring's rule engine has no equivalent of Outlook's `moveCopyToFolder`** (file into a folder while leaving the original in Inbox). Workarounds:
- Downgrade to `changeFolder` (lose the "still in Inbox" property).
- Use `star` instead (keeps it in Inbox visually pinned).
- For Gmail only, `applyLabel` does the right thing (labels are metadata).
- Implement the missing template via a plugin extension — sketched in [`docs/FUTURE_IMPROVEMENTS.md`](FUTURE_IMPROVEMENTS.md) "Mailspring `moveCopyToFolder` action".

**Gotcha: Mailspring has no `From: starts with` comparator**, only `contains`. If your source rule used "starts with name@", convert to "contains '@yourdomain'" or rewrite manually.

**Gotcha: sender display-name fallback.** If the source rule's "from contains" value looks like a display name rather than an SMTP address ("WordPress" instead of "wordpress@..."), Mailspring's `from` matcher still works — it tests the full `From:` header line including the display name. Just be aware it'll match anything whose display name *contains* that substring.

## Phase 3 — apply via DevTools snippet

The pattern: open Mailspring → `Cmd+Option+I` → Console → paste a snippet that reads your JSON, resolves folder paths to live category IDs per account, and fires `Actions.addMailRule` per rule.

### DRY-RUN snippet (run this first)

```js
// Dry-run: prints what WOULD be created, doesn't actually create.
(() => {
  const fs = require('fs');
  const { AccountStore, CategoryStore } = require('mailspring-exports');

  const RULES_PATH = '/absolute/path/to/your/rules.json';

  // Optional filter — to scope to one account, list emailAddresses.
  const TARGET_ACCOUNTS = [];

  const draft = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  const allAccounts = AccountStore.accounts();
  const accounts = TARGET_ACCOUNTS.length === 0
    ? allAccounts
    : allAccounts.filter(a => TARGET_ACCOUNTS.includes(a.emailAddress));

  const out = [`[mml-productivity] DRY RUN — ${draft.length} rules × ${accounts.length} accounts`];
  let ok = 0, skip = 0;

  for (const acct of accounts) {
    const cats = CategoryStore.categories(acct.id);
    const byName = new Map();
    for (const c of cats) {
      byName.set((c.displayName || '').toLowerCase(), c);
      byName.set((c.name || '').toLowerCase(), c);
    }
    const usesLabels = acct.usesLabels && acct.usesLabels();

    for (const rule of draft) {
      let err = null;
      const newActions = [];
      for (const a of rule.actions) {
        if (a.templateKey === 'changeFolder' || a.templateKey === 'moveToLabel' || a.templateKey === 'applyLabel') {
          const cat = byName.get(String(a.value).toLowerCase());
          if (!cat) { err = `folder "${a.value}" not found in ${acct.emailAddress}`; break; }
          newActions.push({ ...a, templateKey: usesLabels ? 'moveToLabel' : 'changeFolder', value: cat.id });
        } else {
          newActions.push(a);
        }
      }
      if (err) {
        out.push(`SKIP  [${acct.emailAddress.padEnd(28)}] ${rule.name}  —  ${err}`);
        skip++; continue;
      }
      const dest = newActions
        .filter(a => a.templateKey === 'changeFolder' || a.templateKey === 'moveToLabel')
        .map(a => { for (const c of cats) if (c.id === a.value) return c.displayName; return a.value; })
        .join(', ');
      out.push(`OK    [${acct.emailAddress.padEnd(28)}] ${rule.name.slice(0,50).padEnd(50)} → ${dest}${rule.disabled ? '  [DISABLED]' : ''}`);
      ok++;
    }
  }
  out.push(''); out.push(`[DRY-RUN] Would create: ${ok}   Skipped: ${skip}`);
  return out.join('\n');
})();
```

The IIFE-returns-string pattern bypasses console filter settings — Mailspring's DevTools console sometimes hides `console.log` output behind the level filter.

Read the output. Every `OK` line is a rule that will be created with a resolved destination. Every `SKIP` line is a missing folder — create the folder first (see [`MAILSPRING_SETUP.md`](MAILSPRING_SETUP.md)) or remove the rule.

### LIVE snippet

Once dry-run looks right, swap the snippet's body to call `Actions.addMailRule`:

```js
// Same as above, but replace the "OK" output block with:
Actions.addMailRule({
  name: rule.name,
  accountId: acct.id,
  conditionMode: rule.conditionMode,
  conditions: rule.conditions,
  actions: newActions,
  disabled: rule.disabled === true,
});
out.push(`CREATED [${acct.emailAddress}] ${rule.name}`);
```

Run it once. Open Mailspring Preferences → Mail Rules to verify the rules appear. They'll be enabled by default (except any you marked `disabled: true` in the JSON).

### Backfill on existing inbox (optional)

By default new Mailspring rules only fire on mail received AFTER rule creation. To run them against your current inbox contents:

```js
const { Actions, AccountStore } = require('mailspring-exports');
for (const acct of AccountStore.accounts()) {
  Actions.startReprocessingMailRules(acct.id);
}
```

Walks the inbox in batches of 50 threads. Watch the rules-prefs page for progress. Stop early:

```js
for (const acct of AccountStore.accounts()) {
  Actions.stopReprocessingMailRules(acct.id);
}
```

### Rollback

Delete rules by name pattern:

```js
const { Actions } = require('mailspring-exports');
const rules = JSON.parse(window.localStorage.getItem('MailRules-V2') || '[]');
const toDelete = rules.filter(r => /\(Outlook #\d+\)/.test(r.name));  // adapt the pattern
console.log(`Deleting ${toDelete.length} rules...`);
for (const r of toDelete) Actions.deleteMailRule(r.id);
```

Folders created in [`MAILSPRING_SETUP.md`](MAILSPRING_SETUP.md) are NOT touched by this — destroy them separately if needed.

## Loop hazards

Watch for rules that include a `forward` action where the destination address is one of your `me_addresses` — the forwarded message arrives again, may re-trigger the same rule, and you've made a loop. Mailspring's `MailRules-Auto-Since` watermark limits the blast radius but doesn't prevent the first reflection. Audit forward rules carefully; consider downgrading to `changeFolder` only.

## Address-fallback rules

If your source rules were created back when display names were stored but SMTP addresses weren't (older Outlook had this happen), the `from-contains` value may be a display-name substring rather than an address. The rule will still fire, but it'll match anything whose display name *contains* that string — possibly broader than intended in your live inbox. Re-tighten by editing the rule in Mailspring's UI after import.
