# Mailspring setup — accounts, folders, plugin install

> Where to click and what DevTools snippets to paste to get Mailspring ready for this system. ~30 minutes if everything goes smoothly.

## 1. Install Mailspring

```sh
brew install --cask mailspring
```

Or download from [getmailspring.com](https://getmailspring.com/). Confirmed working on 1.21.x; later versions may need plugin tweaks.

## 2. Add your email accounts

Mailspring → File → Add Account. Walk through OAuth for Gmail; IMAP for everything else (Zoho, Fastmail, iCloud, etc.). The system supports any combination — most setups have 1–3 accounts.

After adding accounts, verify Mailspring's `~/Library/Application Support/Mailspring/config.json` lists them all:

```sh
python3 -c "import json,os; c=json.load(open(os.path.expanduser('~/Library/Application Support/Mailspring/config.json'))); [print(a['emailAddress'], a['provider']) for a in c.get('accounts',[])]"
```

## 3. Create the four disposition folders

You need `Pending/Waiting/Complete/Later` to exist in each Mailspring account so the disposition keystrokes (`Cmd+Shift+1..4`) can move threads into them. Three ways to do this, fastest first.

### Option A — DevTools snippet (fastest, recommended)

1. Open Mailspring → press `Cmd+Option+I` to open DevTools → click the **Console** tab.
2. If the console says "pasting is disabled," type `allow pasting` (no quotes) and hit Enter.
3. Paste this snippet:

```js
(() => {
  const { SyncbackCategoryTask, Actions, AccountStore } = require('mailspring-exports');
  const NAMES = ['Pending/Waiting/Complete/Later'];
  let queued = 0;
  for (const acct of AccountStore.accounts()) {
    for (const name of NAMES) {
      Actions.queueTask(SyncbackCategoryTask.forCreating({ name, accountId: acct.id }));
      queued++;
    }
  }
  return `Queued ${queued} folder-create tasks. Wait ~15s, then verify.`;
})();
```

Wait ~15 seconds for Mailspring's syncback to finish, then verify:

```js
(() => {
  const { CategoryStore, AccountStore } = require('mailspring-exports');
  const EXPECTED = ['Pending/Waiting/Complete/Later'];
  let out = '';
  for (const acct of AccountStore.accounts()) {
    const cats = CategoryStore.categories(acct.id).map(c => c.displayName);
    const missing = EXPECTED.filter(n => !cats.includes(n));
    out += `${acct.emailAddress}: ${missing.length === 0 ? 'ALL PRESENT' : 'MISSING: ' + missing.join(', ')}\n`;
  }
  return out.trim();
})();
```

Should print `ALL PRESENT` for every account. Re-run the create snippet if anything's missing after 30s.

### Option B — Manual UI

Right-click each account in the sidebar → New Folder → type `Pending/Waiting/Complete/Later`. Per account. Slow and error-prone with multiple accounts.

### Option C — IMAP-side creation

If you have direct IMAP access (e.g., via a Python script using `imapclient`), you can `CREATE Pending` etc. Won't work for Gmail (use the label UI) and bypasses Mailspring's auth — usually not worth it.

### Why `Complete` and not `Done`?

Gmail reserves the label name `Done` as a system label and blocks user-creation under that name. To keep behavior identical across IMAP and Gmail, we use `Complete` everywhere.

## 4. Build + symlink the plugin

```sh
cd /path/to/this-repo/plugin
npm install
npx tsc                   # outputs to lib/

# Symlink into Mailspring's package directory
ln -s "$(pwd)" ~/Library/Application\ Support/Mailspring/packages/mml-productivity
```

Restart Mailspring (`Cmd+Q` then re-open, OR `Cmd+Option+L` to reload the window). In DevTools console, look for log lines starting with `[mml-productivity]` confirming the plugin activated.

For ongoing development: `npx tsc --watch` in another terminal so edits to `src/` flow into `lib/` automatically. Press `Cmd+Option+L` in Mailspring to reload after each change.

## 5. Useful Mailspring keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Option+I` | Open DevTools |
| `Cmd+Option+L` | Reload main window (survives a `tsc --watch` edit-loop) |
| `Cmd+Shift+M` | Mark as Spam (Mailspring native) |
| `Cmd+Shift+1..4` | (Plugin) Move to Pending/Waiting/Complete/Later |
| `Cmd+Option+1..4` | (Plugin) Same, alternate keystroke for `Shift+3/4` colliding with macOS screenshots |
| `Ctrl+Cmd+0..9` | (Plugin) Rate focused message |
| `Ctrl+Cmd+N` | (Plugin) Add note to latest rating on focused message |

## 6. (Optional) Routed/* folder set for legacy rule import

If you're going to import a large legacy rule set (Outlook .rwz, Gmail filters, etc. — see [`MAILSPRING_RULES_RECIPE.md`](MAILSPRING_RULES_RECIPE.md)), it's helpful to create a nested folder set like `Routed/<bucket>` to keep destinations tidy in the sidebar.

The pattern: pick the buckets your rules need (e.g., `Routed/newsletters`, `Routed/notifications`, `Routed/social`, etc.), and use the same `SyncbackCategoryTask.forCreating` snippet from step 3, but with paths like `Routed/newsletters` instead of bare folder names. Mailspring + most IMAP servers auto-create the `Routed` parent on first child-create.

## Troubleshooting

**Mailspring → File → Preferences shows no Mail Rules section.**
Mail Rules are per-account. Go to the account's settings inside Preferences.

**`Actions.queueTask` calls succeed but folders never appear.**
Check Mailspring → Activity (lower-left) for syncback errors. Common cause: IMAP server temporarily rejecting creates due to quota or rate limit. Retry the snippet after a minute.

**Plugin doesn't load.**
Verify the symlink exists and points at a real directory: `ls -laL ~/Library/Application\ Support/Mailspring/packages/mml-productivity`. Reload window. Check DevTools console for `[mml-productivity]` log lines or errors.

**Plugin loads but no badges render.**
See [`docs/ARCHITECTURE.md` "Quick health check"](ARCHITECTURE.md#quick-health-check) — most likely the sidecar isn't running or the warehouse is empty.
