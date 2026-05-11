# Mailspring 1.21 plugin API — notes and gotchas

> What works, what doesn't, and what you have to monkey-patch. Captured at runtime + by reading the extracted `app.asar`.

If you're building plugin features against Mailspring 1.21, read this before reading the source. Lots of things that *seem* like they should be public API aren't, and a few things in the docs no longer exist.

## The supported surface

| Symbol | Status | Notes |
|---|---|---|
| `ComponentRegistry.register(C, { role })` | ✅ works | Roles are flat strings: `'ThreadListIcon'`, `'ThreadListTimestamp'`, `'ThreadListQuickAction'`, `'ThreadActionsToolbarButton'`, `'MessageHeader'`. |
| `AppEnv.commands.add(document.body, name, handler)` | ✅ works | Register command handlers programmatically. |
| `keymaps/*.json` in plugin dir | ✅ auto-loaded | Mailspring's package loader (`src/package.js loadKeymaps()`) auto-discovers and loads keymap JSON files. Just ship them — no API call needed. Format: `{ "command:name": "keystroke" }`. |
| `AppEnv.keymaps.loadKeymap(path)` | ✅ exists | Programmatic API. You won't need to call it directly. |
| `AppEnv.keymaps.add(...)` | ❌ does NOT exist | Despite being suggested in some docs. |
| `Actions.queueTask(task)` | ✅ works | Submit a task to Mailspring's task queue. |
| `AccountStore.accountForId(id)` | ✅ works | Account lookup. |
| `CategoryStore.categories(account)` | ✅ works | Returns array of folders/labels for an account. Match by `displayName`. |
| `ThreadListStore.dataSource().selection.items()` | ✅ works | Multi-select threads. |
| `FocusedContentStore.focused('thread')` | ✅ works | Single focused thread. |
| `ChangeFolderTask` (singular!) | ✅ works | `{ source, threads, folder }`. For IMAP / non-Gmail moves. **Note the singular form** — `ChangeFoldersTask` (plural) does NOT exist and will throw `TypeError: ... is not a constructor`. |
| `ChangeLabelsTask` (plural!) | ✅ works | `{ source, threads, labelsToAdd, labelsToRemove }`. For Gmail. To make a thread leave the inbox: remove all current labels (including Inbox) and add the destination. |
| `Folder` / `Label` (from mailspring-exports) | ✅ works | Use `dest instanceof Folder` to branch IMAP vs Gmail. |

## Keystroke gotchas

- **`Cmd+1..9`** (no shift) are reserved by Mailspring's base keymap for `window:select-account-N`. Use `Cmd+Shift+...` or `Cmd+Option+...`.
- **`Cmd+Shift+3` and `Cmd+Shift+4`** collide with macOS's screenshot shortcuts — those keystrokes never reach the renderer process. Provide `Cmd+Option+3` / `Cmd+Option+4` as alternates.
- **`window.addEventListener('keydown', ...)`** does NOT fire when modifiers are involved. Mailspring's command pipeline consumes the keydown before the bubble phase reaches your window listener. Use the keymaps/*.json + `AppEnv.commands.add` path.
- **`Cmd+Option+I`** opens DevTools. `Cmd+Option+L` reloads the window. Both useful when debugging.

## Things that look like they should work but don't

### Sort the thread list by a plugin-computed field

There is no public sort API for plugins. We tried four paths:

1. **Public sort API for plugins** — confirmed absent. `perspectiveSubclasses: Array(0)` from runtime introspection — there's no plugin-facing perspective registry to swap in a custom-sorted variant.
2. **Monkey-patch `MailboxPerspective.prototype.threads`** — does not intercept the render path. Wrapping `.then()` AND `.subscribe()` AND `.observe()` on the returned `ModelQuery` does not affect rendered order. The thread list pulls results through a `MutableQuerySubscription` layer that constructs its own subscription internally and bypasses the wraps.
3. **DB-layer intercept (`MutableQuerySubscription`)** — possible in principle but requires entering Mailspring's private API space. Not attempted.
4. **Fork Mailspring** — the nuclear option. Mailspring PR [#2424 "Custom sort"](https://github.com/Foundry376/Mailspring/pull/2424) has been open since Aug 2022; the maintainer flagged SQLite indexing as the underlying gap.

**Workaround:** render an engagement badge instead. The inbox stays in date order; you scan badges for triage. Red pops, gray doesn't.

### Add a custom column to the thread list

There is no public column-extension API. Two-option columns (badge-style icons) work via `ThreadListIcon` and `ThreadListTimestamp`. A real column with width, sort, header, and ListTabular semantics requires a monkey-patch.

**The hack** (see `installOwnerRecipientColumn()` in `plugin/src/main.js`):

1. Find Mailspring's internal `ThreadListColumns` module via `require.cache` (Node module cache). Walk the cache for an export that has a `Wide` array.
2. Construct a `ListTabular.Column` instance with your own resolver.
3. **Replace the `Wide` array reference** — do NOT mutate in place. `MultiselectList.componentDidUpdate` does referential equality on the columns prop; a splice with the same array reference doesn't trigger a re-compute.

```js
const newWide = [...tlc.Wide];
newWide.splice(insertAt, 0, myColumn);
tlc.Wide = newWide;  // replace reference, not mutate
```

If you mutate in place, the column won't render. This took an embarrassingly long time to figure out.

### Use `react-dom` for portal-style overlays

`react-dom` is NOT exposed in Mailspring's plugin sandbox. You can `require('react')` for `<JSX/>` inside registered components, but you cannot mount portals to arbitrary DOM nodes (e.g., for an overlay near the focused message).

**Workaround:** use vanilla DOM. The note-input overlay (`Ctrl+Cmd+N`) builds its UI with `document.createElement(...)` and `appendChild()`. See `plugin/src/note-input-overlay.jsx`.

### Use `Thread.participants` as a method

`Thread.participants` is a **property** (array), not a method. Calling it as a function crashes with `TypeError: thread.participants is not a function`. Defensive shape-detection is easy: `Array.isArray(thread.participants) ? thread.participants : thread.participants()`.

## CSS gotchas

Mailspring's leftmost slot (`ThreadListIcon`) is sized for unread/attachment dots — ~16-20px wide — and **clips** content wider than that. To render a rating pill or any wider badge there, inject `<style>` at activate time:

```css
.thread-injected-icons { overflow: visible; min-width: 60px; }
.mml-engagement-badge { opacity: 1 !important; }
```

The `opacity: 1 !important` is because the parent quick-action containers have hover-based opacity rules that hide the badge unless the row is hovered.

## ThreadActionsToolbarButton — partial mystery

Registering a component at role `ThreadActionsToolbarButton` runs without error, and that role IS what core's `MoveButtons`, `FlagButtons`, snooze, and send-reminders all use. But the rendered button is not always visible in the message-list toolbar.

Investigation deferred — the keystroke-driven path (`Cmd+Shift+1..4`) is the load-bearing UI anyway. If you need the toolbar buttons too: open DevTools (`Cmd+Option+I`), find the toolbar in the elements panel, and trace which CSS class or container is hiding it.

## Debug commands

```sh
# View Mailspring's source post-asar-extract
npx asar extract /Applications/Mailspring.app/Contents/Resources/app.asar /tmp/mailspring-src
# Grep for the symbol you want to monkey-patch
grep -rln "ThreadListColumns" /tmp/mailspring-src/internal_packages/thread-list/
```

```sh
# Reload the plugin without restarting Mailspring
# Cmd+Option+L (window:reload). Survives a `tsc --watch` edit-loop.
```

```js
// In DevTools console — list everything ComponentRegistry has registered
require('mailspring-exports').ComponentRegistry.listeners('registered')
```
