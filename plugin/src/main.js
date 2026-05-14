import {
  ComponentRegistry,
  React,
} from 'mailspring-exports';

import EngagementBadge from './engagement-badge';
import DispositionToolbar from './disposition-toolbar';
import TldrOverlay from './tldr-overlay';
import OwnerRecipientColumn from './owner-recipient-column';
import { moveSelectedTo, DISPOSITIONS } from './disposition-actions';
import { registerTagCommands, unregisterTagCommands } from './tag-keystroke-handler';
import { registerNoteCommand, unregisterNoteCommand } from './note-keystroke-handler';
import { registerEventCommand, unregisterEventCommand } from './event-keystroke-handler';
import { registerRoutedCommands, unregisterRoutedCommands } from './routed-keystroke-handler';
import { registerSortViewCommand, unregisterSortViewCommand } from './sort-view-handler';
import { registerSortCycleCommand, unregisterSortCycleCommand } from './sort-cycle-handler';
import { registerAcceptCommand, unregisterAcceptCommand } from './accept-suggestion-handler';
import { registerIdHud, unregisterIdHud } from './id-hud-handler';
const sortPatch = require('./sort-patch');
import {
  activate as activateAutoIntake,
  deactivate as deactivateAutoIntake,
} from './auto-intake';
import {
  activate as activateRoutedSidebar,
  deactivate as deactivateRoutedSidebar,
} from './sidebar-extension';

// =====================================================================
// Increment A — register EngagementBadge in the ThreadListIcon slot.
// Mailspring's slot is sized for unread/attachment dots (~16-20px); the
// stylesheet block below forces overflow:visible + min-width:60px on the
// parent containers so the badge renders at full width.
// =====================================================================

// =====================================================================
// Stylesheet injection — overrides parent-slot clipping so the badge
// renders at its real width and is visually findable on screen.
// =====================================================================

const STYLE_TAG_ID = 'mml-productivity-styles';
const STYLE_CSS = `
  /* ----- Layer 1: Person-tier rainbow band ----- */
  .mml-person-band {
    display: inline-block;
    min-width: 20px;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    color: #fff;
    vertical-align: middle;
    white-space: nowrap;
    opacity: 1 !important;
    visibility: visible !important;
  }
  /* Light-swatch ratings (1–4) need dark text for legibility against
     the gray/cool-blue backgrounds. */
  .mml-person-band.mml-rating-1,
  .mml-person-band.mml-rating-2,
  .mml-person-band.mml-rating-3,
  .mml-person-band.mml-rating-4 {
    color: #333;
  }

  /* ----- Layer 1.5: LLM rating-suggestion chip (Phase 6.0.f) -----
     Same 1-9 color palette as PersonBand, but hex-shaped so it reads
     as "system guess" instead of "your decision." Slots between
     PersonBand and CategoryTag in the badge dispatch. Size matched to
     PersonBand visual weight so row heights don't shift. */
  .mml-rating-chip {
    display: inline-block;
    min-width: 20px;
    height: 18px;
    padding: 0 4px;
    box-sizing: border-box;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
    color: #fff;
    vertical-align: middle;
    white-space: nowrap;
    clip-path: polygon(15% 0%, 85% 0%, 100% 50%, 85% 100%, 15% 100%, 0% 50%);
    -webkit-clip-path: polygon(15% 0%, 85% 0%, 100% 50%, 85% 100%, 15% 100%, 0% 50%);
    cursor: default;
    opacity: 1 !important;
    visibility: visible !important;
  }
  .mml-rating-chip.mml-rating-1,
  .mml-rating-chip.mml-rating-2,
  .mml-rating-chip.mml-rating-3,
  .mml-rating-chip.mml-rating-4 {
    color: #333;
  }

  /* ----- Layer 2: Category tag (gray, subtle) ----- */
  .mml-category-tag {
    display: inline-block;
    min-width: 22px;
    padding: 0 4px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
    color: #555;
    background: #ececec;
    vertical-align: middle;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    opacity: 0.85;
  }

  /* ----- Layer 3: Content marker (tiny dot) ----- */
  .mml-content-marker {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #999;
    vertical-align: middle;
    opacity: 0.8;
  }

  /* ----- the owner-recipient column (its own real ListTabular column) ----- */
  .mml-owner-recipient-col {
    display: inline-block;
    font-size: 12px;
    line-height: 16px;
    color: #666;
    font-weight: 500;
    letter-spacing: 0.2px;
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* The ThreadListIcon slot is sized for unread/attachment dots
     (~16-20px) and would clip our badge; relax overflow + min-width on
     the wrapping containers so the badge can render at full width. The
     owner-recipient label moved to its own column (below), so 36px is
     enough now for the rating pill alone. */
  .thread-icon, .thread-injected-icons,
  [data-component-name="ThreadListIcon"] {
    overflow: visible !important;
    min-width: 36px !important;
  }

  /* ----- TLDR overlay above message body ----- */
  .mml-tldr-overlay {
    margin: 8px 12px 4px 12px;
    padding: 6px 10px;
    border: 1px solid #d6d6d6;
    border-radius: 4px;
    background: #f8f8f4;
    font-size: 12px;
    line-height: 1.4;
    color: #333;
  }
  .mml-tldr-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 10px;
    color: #888;
  }
  .mml-tldr-label {
    font-family: ui-monospace, SFMono-Regular, monospace;
    letter-spacing: 0.6px;
    font-weight: 700;
    color: #555;
  }
  .mml-tldr-score {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: #999;
  }
  .mml-tldr-dismiss {
    margin-left: auto;
    padding: 0 6px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: #999;
    font-size: 14px;
    line-height: 1;
  }
  .mml-tldr-body {
    color: #222;
  }

  /* ----- Note input overlay (Ctrl+Cmd+N) ----- */
  .mml-note-overlay-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.18);
    z-index: 99998;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 18vh;
  }
  .mml-note-overlay {
    width: 360px;
    max-width: calc(100vw - 32px);
    background: #fff;
    border: 1px solid #c9c9c9;
    border-radius: 6px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2);
    padding: 10px 12px;
    z-index: 99999;
  }
  .mml-note-overlay-header {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: #888;
    margin-bottom: 6px;
  }
  .mml-note-overlay-input {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 13px;
    box-sizing: border-box;
  }
  .mml-note-overlay-input:focus {
    outline: 2px solid #6aa6e8;
    outline-offset: -1px;
  }
  .mml-note-overlay-footer {
    margin-top: 6px;
    font-size: 10px;
    color: #888;
  }
  .mml-note-overlay-error {
    color: #c83838;
  }
  .mml-note-overlay-hint {
    color: #888;
  }

  /* ----- OwnerAddr placeholder when sidecar has no to_me_addr ----- */
  .mml-owner-recipient-empty {
    color: #888;
    font-size: 18px;
    line-height: 1;
    font-weight: 700;
    opacity: 0.85;
  }
  .list-column.list-column-OwnerAddr {
    align-items: center;
    text-align: left;
    background: rgba(0, 80, 180, 0.06);
    border-left: 1px solid rgba(0, 80, 180, 0.18);
    border-right: 1px solid rgba(0, 80, 180, 0.18);
  }
`;

function installStyleTag() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_TAG_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_TAG_ID;
  tag.appendChild(document.createTextNode(STYLE_CSS));
  document.head.appendChild(tag);
}

function removeStyleTag() {
  if (typeof document === 'undefined') return;
  const tag = document.getElementById(STYLE_TAG_ID);
  if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
}

// =====================================================================
// Phase 1 sticky native sort — see src/sort-patch.js. Replaces the prior
// Increment B post-sort patch (which only re-ordered the loaded range,
// not the underlying result set, and was a structural no-op once badges
// already provided the visual reordering signal).
// =====================================================================

// =====================================================================
// Increment D — keystroke bindings.
// =====================================================================

// Mailspring auto-loads keymaps/*.json at activate time
// (see src/package.js loadKeymaps). Our keymaps/mml-engagement-spike.json
// binds mod+shift+1..4 and mod+alt+1..4 to command names; we register
// the handlers for those commands here. AppEnv.commands.add(...) is the
// API Mailspring's own packages use (we earlier learned that
// AppEnv.keymaps.add doesn't exist, but AppEnv.commands.add does).
const COMMAND_TO_FOLDER = {
  'mml-engagement-spike:move-to-pending':      'Pending',
  'mml-engagement-spike:move-to-pending-alt':  'Pending',
  'mml-engagement-spike:move-to-waiting':      'Waiting',
  'mml-engagement-spike:move-to-waiting-alt':  'Waiting',
  'mml-engagement-spike:move-to-complete':     'Complete',
  'mml-engagement-spike:move-to-complete-alt': 'Complete',
  'mml-engagement-spike:move-to-fun':          'Fun',
  'mml-engagement-spike:move-to-fun-alt':      'Fun',
};

let __commandDisposables = [];
let __fallbackKeyListener = null;

function registerKeymapsViaAppEnv() {
  if (typeof AppEnv === 'undefined' || !AppEnv || !AppEnv.commands) {
    // eslint-disable-next-line no-console
    console.warn('[mml-engagement-spike] AppEnv.commands not available; relying on fallback keydown.');
    return false;
  }
  for (const [name, folder] of Object.entries(COMMAND_TO_FOLDER)) {
    try {
      const d = AppEnv.commands.add(document.body, name, () => {
        // eslint-disable-next-line no-console
        console.info(`[mml-engagement-spike] command fired: ${name} -> ${folder}`);
        document.title = `[mml] ${name}`;
        setTimeout(() => { document.title = 'Mailspring'; }, 2500);
        moveSelectedTo(folder);
      });
      __commandDisposables.push(d);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mml-engagement-spike] failed to register command ${name}:`, err);
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[mml-engagement-spike] registered ${__commandDisposables.length} commands. ` +
    'Try Cmd+Shift+1..4 (Pending/Waiting/Complete/Fun) or Cmd+Opt+1..4.'
  );
  return true;
}

function registerKeymapsFallback() {
  const codeToFolder = {
    'Digit1': 'Pending',
    'Digit2': 'Waiting',
    'Digit3': 'Complete',
    'Digit4': 'Fun',
  };
  // Diagnostic without-DevTools: every keydown updates document.title with
  // a short summary of modifiers + e.code. the owner can read his own keystrokes
  // off Mailspring's window title bar to verify the handler fires.
  const __originalTitle = document.title;
  let __titleResetTimer = null;

  __fallbackKeyListener = (e) => {
    const summary = `[mml] ${e.metaKey?'⌘':''}${e.altKey?'⌥':''}${e.shiftKey?'⇧':''}${e.ctrlKey?'⌃':''} ${e.code}`;
    document.title = summary;
    if (__titleResetTimer) clearTimeout(__titleResetTimer);
    __titleResetTimer = setTimeout(() => { document.title = __originalTitle; }, 4000);

    if (!e.metaKey) return;
    if (!(e.shiftKey || e.altKey)) return;
    const folder = codeToFolder[e.code];
    if (!folder) return;
    e.preventDefault();
    e.stopPropagation();
    document.title = `[mml] firing -> ${folder}`;
    // eslint-disable-next-line no-console
    console.info(
      `[mml-engagement-spike] fallback keystroke: ${e.code} ` +
      `(meta=${e.metaKey} shift=${e.shiftKey} alt=${e.altKey}) -> ${folder}`
    );
    moveSelectedTo(folder);
  };
  // Register on BOTH window and document, both in capture phase, to maximize
  // the chance we see the keydown before Mailspring's handlers eat it.
  window.addEventListener('keydown', __fallbackKeyListener, true);
  document.addEventListener('keydown', __fallbackKeyListener, true);
  document.body && document.body.addEventListener('keydown', __fallbackKeyListener, true);
}

function unregisterKeymaps() {
  for (const d of __commandDisposables) {
    try { if (d && d.dispose) d.dispose(); } catch (e) {}
  }
  __commandDisposables = [];
  if (__fallbackKeyListener) {
    window.removeEventListener('keydown', __fallbackKeyListener, true);
    document.removeEventListener('keydown', __fallbackKeyListener, true);
    document.body && document.body.removeEventListener('keydown', __fallbackKeyListener, true);
    __fallbackKeyListener = null;
  }
}

// =====================================================================
// activate / deactivate
// =====================================================================

export function activate() {
  // eslint-disable-next-line no-console
  console.info('[mml-engagement-spike] activate (rev 2 + visual-debug)');

  // Phase 3 Layer 1-3 badge — same slot as the Phase 1 spike. The badge
  // itself now fetches from the sidecar and renders one of three layer
  // components (PersonBand / CategoryTag / ContentMarker) or null.
  ComponentRegistry.register(EngagementBadge, { role: 'ThreadListIcon' });
  installStyleTag();

  // Phase 3 TLDR overlay — render above message bodies. Mailspring 1.21
  // uses MessageHeader for content immediately above the body. Try a few
  // plausible roles; the one that has a render slot will fire.
  for (const role of [
    'MessageHeader',
    'MessageList:Header',
    'MessageItem:Header',
    'MessageListHeader',
  ]) {
    try {
      ComponentRegistry.register(TldrOverlay, { role });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mml-productivity] failed to register TldrOverlay at role=${role}`, err);
    }
  }

  // Increment C — try several plausible role names. Mailspring 1.21 may have
  // renamed/relocated the toolbar role; we register against all of them and
  // the one that actually has a render slot will show up. Each registration
  // tags the displayName so we can tell which one rendered.
  for (const role of [
    'ThreadActionsToolbarButton',
    'ThreadList:Toolbar',
    'MessageList:Toolbar',
    'MessageListHeaders',
    'ThreadList:ToolbarButton',
  ]) {
    try {
      ComponentRegistry.register(DispositionToolbar, { role });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mml-engagement-spike] failed to register DispositionToolbar at role=${role}`, err);
    }
  }

  // Phase 1 sticky native sort — install the Thread.naturalSortOrder
  // override before anything else triggers a thread query. Fresh
  // subscriptions (perspective changes, range scrolls, persist refetches)
  // will pick up the patched sort automatically.
  sortPatch.activate();
  registerSortCycleCommand();

  // Increment D
  let usedAppEnv = false;
  try { usedAppEnv = registerKeymapsViaAppEnv(); } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-engagement-spike] AppEnv keymap registration failed; falling back. err=', err);
  }
  if (!usedAppEnv) {
    registerKeymapsFallback();
    // eslint-disable-next-line no-console
    console.info('[mml-engagement-spike] keymaps registered via window.keydown fallback (cmd-shift-1..4).');
  } else {
    // eslint-disable-next-line no-console
    console.info('[mml-engagement-spike] keymaps registered via AppEnv (cmd-shift-1..4).');
  }

  // eslint-disable-next-line no-console
  console.info(
    `[mml-engagement-spike] dispositions: ${DISPOSITIONS.join(', ')}. Pre-create these as folders in each account.`
  );

  // Phase 3 — manual tag (Ctrl+Cmd+0..9) and note (Ctrl+Cmd+N) commands.
  // Keymap entries live in keymaps/mml-tags.json (auto-loaded by Mailspring).
  registerTagCommands();
  registerNoteCommand();

  // Phase 5 — create-event (Ctrl+Cmd+E). Keymap in keymaps/mml-events.json.
  registerEventCommand();

  // Phase 4 — install a real thread-list column for the owner-recipient.
  // Mailspring exposes no public API for this, so we mutate the internal
  // Wide columns array. ListTabular's MultiselectList re-reads on render,
  // so a Cmd+Q reopen guarantees the new column appears.
  installOwnerRecipientColumn();

  // Phase 5.5 — unified "Routed" parent (with category-name children
  // aggregated across both accounts) in the All Accounts sidebar section.
  activateRoutedSidebar();

  // Phase 5.5.1 — Cmd+Option+<letter> shortcuts that move the
  // selected thread(s) into the corresponding Routed/<name> folder.
  // Keymap entries live in keymaps/mml-routed.json (auto-loaded).
  registerRoutedCommands();

  // Phase 5.5.2 — Cmd+Option+Y: accept the LLM's routing suggestion for
  // the focused thread. Fetches /route-suggest on press; first call per
  // thread triggers a Claude classification.
  registerAcceptCommand();

  // Phase 5.5.3 — auto-intake: subscribe to DatabaseStore Message persists,
  // debounce 5s, call /intake-now so warehouse stays current with Mailspring
  // without manual `python -m mml_classifier.mailspring_intake --commit`.
  activateAutoIntake();

  // Phase 7.0 — Cmd+Option+V: sortable list view of threads in current
  // perspective. Pulls threads from ThreadListStore.dataSource(), enriches
  // via the sidecar's /threads-enrich, renders a click-to-sort overlay.
  registerSortViewCommand();

  // Right-click on a thread row → debug HUD listing RFC IDs + warehouse ids.
  registerIdHud();
}

function findInstancesByDisplayName(domSel) {
  const el = document.querySelector(domSel);
  if (!el) return {};
  const fiberKey = Object.keys(el).find(k =>
    k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
  );
  if (!fiberKey) return {};
  const found = {};
  let fiber = el[fiberKey];
  while (fiber) {
    const sn = fiber.stateNode;
    if (sn && sn.constructor) {
      const dn = sn.constructor.displayName || sn.constructor.name;
      if (dn && !found[dn]) found[dn] = sn;
    }
    fiber = fiber.return;
  }
  return found;
}

function nukeListTabularItemCaches() {
  // ListTabularItem caches column cells in _columnCache; the cache invalidates
  // only when this.props.columns !== nextProps.columns (referential). If our
  // state injection happens to land before nextProps is reconciled, the cache
  // stays stale and the old 5-column DOM persists. Walk every live ListTabularItem
  // instance and null its cache so the next render rebuilds from current columns.
  const items = document.querySelectorAll('.list-item.list-tabular-item');
  let nuked = 0;
  for (const el of items) {
    const fk = Object.keys(el).find(k =>
      k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    if (!fk) continue;
    let fiber = el[fk];
    while (fiber) {
      const sn = fiber.stateNode;
      if (sn && sn.constructor) {
        const dn = sn.constructor.displayName || sn.constructor.name;
        if (dn === 'ListTabularItem') {
          sn._columnCache = null;
          if (typeof sn.forceUpdate === 'function') sn.forceUpdate();
          nuked += 1;
          break;
        }
      }
      fiber = fiber.return;
    }
  }
  return nuked;
}

function injectColumnsIntoMultiselectList(newWide) {
  // Directly set MultiselectList state. Bypasses props.columns !== state._lastColumns
  // referential equality check — setting both ensures that on the very next render
  // (whether from us, ThreadList, or any other source), the new state is preserved.
  const { MultiselectList, ThreadList } = findInstancesByDisplayName('.thread-list');
  let didSomething = false;
  if (MultiselectList && MultiselectList.state) {
    const newComputed = [...newWide];
    if (MultiselectList.state.layoutMode === 'list' && MultiselectList.state._checkmarkColumn) {
      newComputed.unshift(MultiselectList.state._checkmarkColumn);
    }
    MultiselectList.setState({
      computedColumns: newComputed,
      _lastColumns: newWide,
    });
    // eslint-disable-next-line no-console
    console.info(
      `[mml-productivity] injected ${newComputed.length} computedColumns into MultiselectList ` +
      `(names: ${newComputed.map(c => c && c.name).join(', ')}).`
    );
    didSomething = true;
  }
  if (ThreadList && typeof ThreadList.forceUpdate === 'function') {
    ThreadList.forceUpdate();
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] forced ThreadList re-render via fiber walk.');
    didSomething = true;
  }
  // Cache-bust every live ListTabularItem so the next render produces a
  // 6-column row layout instead of reusing the cached 5-column cells.
  const nuked = nukeListTabularItemCaches();
  if (nuked > 0) {
    // eslint-disable-next-line no-console
    console.info(`[mml-productivity] nulled _columnCache on ${nuked} ListTabularItem instances.`);
  }
  return didSomething;
}

function injectColumnsWithRetries(newWide) {
  let attempts = 0;
  const tryOnce = () => {
    attempts += 1;
    try {
      if (injectColumnsIntoMultiselectList(newWide)) return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[mml-productivity] injectColumns threw:', err);
      return;
    }
    if (attempts < 12) {
      setTimeout(tryOnce, 150);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[mml-productivity] could not locate ThreadList/MultiselectList fiber after 12 tries.');
    }
  };
  setTimeout(tryOnce, 50);
}

let __markRecipientColumnInstalled = false;
function installOwnerRecipientColumn() {
  if (__markRecipientColumnInstalled) return;
  try {
    // Find the already-loaded thread-list-columns module via require.cache.
    let tlc = null;
    let tlcKey = null;
    for (const key of Object.keys(require.cache || {})) {
      if (key.endsWith('thread-list-columns.js')) {
        tlc = require.cache[key].exports;
        tlcKey = key;
        break;
      }
    }
    if (!tlc || !Array.isArray(tlc.Wide)) {
      // eslint-disable-next-line no-console
      console.warn('[mml-productivity] thread-list-columns module not in require.cache; column not installed');
      return;
    }

    // Refuse double-install on hot-reload
    if (tlc.Wide.some(c => c && c.name === 'OwnerAddr')) {
      __markRecipientColumnInstalled = true;
      return;
    }

    const componentKit = require('mailspring-component-kit');
    const ListTabular = componentKit.ListTabular;
    if (!ListTabular || !ListTabular.Column) {
      // eslint-disable-next-line no-console
      console.warn('[mml-productivity] ListTabular.Column unavailable; column not installed');
      return;
    }

    const col = new ListTabular.Column({
      name: 'OwnerAddr',
      width: 200,
      resolver: (thread) => React.createElement(OwnerRecipientColumn, { thread }),
    });

    // Insert before Date (Wide index 3 in observed Mailspring 1.21 layout):
    // [★(0), Participants(1), Message(2), Date(3), HoverActions(4)]
    // CRITICAL: replace the array REFERENCE rather than mutating in place.
    // MultiselectList does `props.columns !== state._lastColumns` on update —
    // an in-place splice keeps the same reference and the prop diff fails.
    const insertAt = Math.min(3, tlc.Wide.length);
    const newWide = [...tlc.Wide];
    newWide.splice(insertAt, 0, col);
    tlc.Wide = newWide;
    __markRecipientColumnInstalled = true;
    // eslint-disable-next-line no-console
    console.info(
      `[mml-productivity] inserted OwnerAddr column at index ${insertAt} ` +
      `(via ${tlcKey}); thread list now has ${tlc.Wide.length} columns.`
    );

    // MultiselectList caches columns by referential identity in state._lastColumns.
    // activate() runs after Mailspring's first render, so the cached reference
    // points at the original 5-element Wide. Mailspring's perspective store
    // short-circuits on identity, so re-dispatching the same perspective is a
    // no-op. The reliable escalation: find the live MultiselectList instance via
    // React-fiber walk and directly set state.computedColumns + state._lastColumns
    // so subsequent getDerivedStateFromProps comparisons preserve the injected
    // state. Also forceUpdate ThreadList as a belt-and-suspenders measure.
    injectColumnsWithRetries(newWide);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] installOwnerRecipientColumn failed:', err);
  }
}

export function serialize() {}

export function deactivate() {
  // eslint-disable-next-line no-console
  console.info('[mml-engagement-spike] deactivate');
  ComponentRegistry.unregister(EngagementBadge);
  for (const role of [
    'ThreadActionsToolbarButton',
    'ThreadList:Toolbar',
    'MessageList:Toolbar',
    'MessageListHeaders',
    'ThreadList:ToolbarButton',
  ]) {
    try { ComponentRegistry.unregister(DispositionToolbar); } catch (e) {}
  }
  for (const role of [
    'MessageHeader',
    'MessageList:Header',
    'MessageItem:Header',
    'MessageListHeader',
  ]) {
    try { ComponentRegistry.unregister(TldrOverlay); } catch (e) {}
  }
  removeStyleTag();
  sortPatch.deactivate();
  unregisterSortCycleCommand();
  unregisterKeymaps();
  unregisterTagCommands();
  unregisterNoteCommand();
  unregisterEventCommand();
  unregisterRoutedCommands();
  unregisterSortViewCommand();
  unregisterAcceptCommand();
  deactivateAutoIntake();
  deactivateRoutedSidebar();
  unregisterIdHud();
}
