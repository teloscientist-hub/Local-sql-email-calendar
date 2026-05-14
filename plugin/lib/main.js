"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const engagement_badge_1 = __importDefault(require("./engagement-badge"));
const disposition_toolbar_1 = __importDefault(require("./disposition-toolbar"));
const tldr_overlay_1 = __importDefault(require("./tldr-overlay"));
const mark_recipient_column_1 = __importDefault(require("./owner-recipient-column"));
const disposition_actions_1 = require("./disposition-actions");
const tag_keystroke_handler_1 = require("./tag-keystroke-handler");
const note_keystroke_handler_1 = require("./note-keystroke-handler");
const event_keystroke_handler_1 = require("./event-keystroke-handler");
const routed_keystroke_handler_1 = require("./routed-keystroke-handler");
const sort_view_handler_1 = require("./sort-view-handler");
const sort_cycle_handler_1 = require("./sort-cycle-handler");
const accept_suggestion_handler_1 = require("./accept-suggestion-handler");
const id_hud_handler_1 = require("./id-hud-handler");
const sortPatch = require('./sort-patch');
const auto_intake_1 = require("./auto-intake");
const sidebar_extension_1 = require("./sidebar-extension");
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
    if (typeof document === 'undefined')
        return;
    if (document.getElementById(STYLE_TAG_ID))
        return;
    const tag = document.createElement('style');
    tag.id = STYLE_TAG_ID;
    tag.appendChild(document.createTextNode(STYLE_CSS));
    document.head.appendChild(tag);
}
function removeStyleTag() {
    if (typeof document === 'undefined')
        return;
    const tag = document.getElementById(STYLE_TAG_ID);
    if (tag && tag.parentNode)
        tag.parentNode.removeChild(tag);
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
    'mml-engagement-spike:move-to-pending': 'Pending',
    'mml-engagement-spike:move-to-pending-alt': 'Pending',
    'mml-engagement-spike:move-to-waiting': 'Waiting',
    'mml-engagement-spike:move-to-waiting-alt': 'Waiting',
    'mml-engagement-spike:move-to-complete': 'Complete',
    'mml-engagement-spike:move-to-complete-alt': 'Complete',
    'mml-engagement-spike:move-to-fun': 'Fun',
    'mml-engagement-spike:move-to-fun-alt': 'Fun',
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
                disposition_actions_1.moveSelectedTo(folder);
            });
            __commandDisposables.push(d);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[mml-engagement-spike] failed to register command ${name}:`, err);
        }
    }
    // eslint-disable-next-line no-console
    console.info(`[mml-engagement-spike] registered ${__commandDisposables.length} commands. ` +
        'Try Cmd+Shift+1..4 (Pending/Waiting/Complete/Fun) or Cmd+Opt+1..4.');
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
        const summary = `[mml] ${e.metaKey ? '⌘' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${e.ctrlKey ? '⌃' : ''} ${e.code}`;
        document.title = summary;
        if (__titleResetTimer)
            clearTimeout(__titleResetTimer);
        __titleResetTimer = setTimeout(() => { document.title = __originalTitle; }, 4000);
        if (!e.metaKey)
            return;
        if (!(e.shiftKey || e.altKey))
            return;
        const folder = codeToFolder[e.code];
        if (!folder)
            return;
        e.preventDefault();
        e.stopPropagation();
        document.title = `[mml] firing -> ${folder}`;
        // eslint-disable-next-line no-console
        console.info(`[mml-engagement-spike] fallback keystroke: ${e.code} ` +
            `(meta=${e.metaKey} shift=${e.shiftKey} alt=${e.altKey}) -> ${folder}`);
        disposition_actions_1.moveSelectedTo(folder);
    };
    // Register on BOTH window and document, both in capture phase, to maximize
    // the chance we see the keydown before Mailspring's handlers eat it.
    window.addEventListener('keydown', __fallbackKeyListener, true);
    document.addEventListener('keydown', __fallbackKeyListener, true);
    document.body && document.body.addEventListener('keydown', __fallbackKeyListener, true);
}
function unregisterKeymaps() {
    for (const d of __commandDisposables) {
        try {
            if (d && d.dispose)
                d.dispose();
        }
        catch (e) { }
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
function activate() {
    // eslint-disable-next-line no-console
    console.info('[mml-engagement-spike] activate (rev 2 + visual-debug)');
    // Phase 3 Layer 1-3 badge — same slot as the Phase 1 spike. The badge
    // itself now fetches from the sidecar and renders one of three layer
    // components (PersonBand / CategoryTag / ContentMarker) or null.
    mailspring_exports_1.ComponentRegistry.register(engagement_badge_1.default, { role: 'ThreadListIcon' });
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
            mailspring_exports_1.ComponentRegistry.register(tldr_overlay_1.default, { role });
        }
        catch (err) {
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
            mailspring_exports_1.ComponentRegistry.register(disposition_toolbar_1.default, { role });
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[mml-engagement-spike] failed to register DispositionToolbar at role=${role}`, err);
        }
    }
    // Phase 1 sticky native sort — install the Thread.naturalSortOrder
    // override before anything else triggers a thread query. Fresh
    // subscriptions (perspective changes, range scrolls, persist refetches)
    // will pick up the patched sort automatically.
    sortPatch.activate();
    sort_cycle_handler_1.registerSortCycleCommand();
    // Increment D
    let usedAppEnv = false;
    try {
        usedAppEnv = registerKeymapsViaAppEnv();
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-engagement-spike] AppEnv keymap registration failed; falling back. err=', err);
    }
    if (!usedAppEnv) {
        registerKeymapsFallback();
        // eslint-disable-next-line no-console
        console.info('[mml-engagement-spike] keymaps registered via window.keydown fallback (cmd-shift-1..4).');
    }
    else {
        // eslint-disable-next-line no-console
        console.info('[mml-engagement-spike] keymaps registered via AppEnv (cmd-shift-1..4).');
    }
    // eslint-disable-next-line no-console
    console.info(`[mml-engagement-spike] dispositions: ${disposition_actions_1.DISPOSITIONS.join(', ')}. Pre-create these as folders in each account.`);
    // Phase 3 — manual tag (Ctrl+Cmd+0..9) and note (Ctrl+Cmd+N) commands.
    // Keymap entries live in keymaps/mml-tags.json (auto-loaded by Mailspring).
    tag_keystroke_handler_1.registerTagCommands();
    note_keystroke_handler_1.registerNoteCommand();
    // Phase 5 — create-event (Ctrl+Cmd+E). Keymap in keymaps/mml-events.json.
    event_keystroke_handler_1.registerEventCommand();
    // Phase 4 — install a real thread-list column for the owner-recipient.
    // Mailspring exposes no public API for this, so we mutate the internal
    // Wide columns array. ListTabular's MultiselectList re-reads on render,
    // so a Cmd+Q reopen guarantees the new column appears.
    installOwnerRecipientColumn();
    // Phase 5.5 — unified "Routed" parent (with category-name children
    // aggregated across both accounts) in the All Accounts sidebar section.
    sidebar_extension_1.activate();
    // Phase 5.5.1 — Cmd+Option+<letter> shortcuts that move the
    // selected thread(s) into the corresponding Routed/<name> folder.
    // Keymap entries live in keymaps/mml-routed.json (auto-loaded).
    routed_keystroke_handler_1.registerRoutedCommands();
    // Phase 5.5.2 — Cmd+Option+Y: accept the LLM's routing suggestion for
    // the focused thread. Fetches /route-suggest on press; first call per
    // thread triggers a Claude classification.
    accept_suggestion_handler_1.registerAcceptCommand();
    // Phase 5.5.3 — auto-intake: subscribe to DatabaseStore Message persists,
    // debounce 5s, call /intake-now so warehouse stays current with Mailspring
    // without manual `python -m mml_classifier.mailspring_intake --commit`.
    auto_intake_1.activate();
    // Phase 7.0 — Cmd+Option+V: sortable list view of threads in current
    // perspective. Pulls threads from ThreadListStore.dataSource(), enriches
    // via the sidecar's /threads-enrich, renders a click-to-sort overlay.
    sort_view_handler_1.registerSortViewCommand();
    // Right-click on a thread row → debug HUD listing RFC IDs + warehouse ids.
    id_hud_handler_1.registerIdHud();
}
exports.activate = activate;
function findInstancesByDisplayName(domSel) {
    const el = document.querySelector(domSel);
    if (!el)
        return {};
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!fiberKey)
        return {};
    const found = {};
    let fiber = el[fiberKey];
    while (fiber) {
        const sn = fiber.stateNode;
        if (sn && sn.constructor) {
            const dn = sn.constructor.displayName || sn.constructor.name;
            if (dn && !found[dn])
                found[dn] = sn;
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
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (!fk)
            continue;
        let fiber = el[fk];
        while (fiber) {
            const sn = fiber.stateNode;
            if (sn && sn.constructor) {
                const dn = sn.constructor.displayName || sn.constructor.name;
                if (dn === 'ListTabularItem') {
                    sn._columnCache = null;
                    if (typeof sn.forceUpdate === 'function')
                        sn.forceUpdate();
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
        console.info(`[mml-productivity] injected ${newComputed.length} computedColumns into MultiselectList ` +
            `(names: ${newComputed.map(c => c && c.name).join(', ')}).`);
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
            if (injectColumnsIntoMultiselectList(newWide))
                return;
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[mml-productivity] injectColumns threw:', err);
            return;
        }
        if (attempts < 12) {
            setTimeout(tryOnce, 150);
        }
        else {
            // eslint-disable-next-line no-console
            console.warn('[mml-productivity] could not locate ThreadList/MultiselectList fiber after 12 tries.');
        }
    };
    setTimeout(tryOnce, 50);
}
let __markRecipientColumnInstalled = false;
function installOwnerRecipientColumn() {
    if (__markRecipientColumnInstalled)
        return;
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
            resolver: (thread) => mailspring_exports_1.React.createElement(mark_recipient_column_1.default, { thread }),
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
        console.info(`[mml-productivity] inserted OwnerAddr column at index ${insertAt} ` +
            `(via ${tlcKey}); thread list now has ${tlc.Wide.length} columns.`);
        // MultiselectList caches columns by referential identity in state._lastColumns.
        // activate() runs after Mailspring's first render, so the cached reference
        // points at the original 5-element Wide. Mailspring's perspective store
        // short-circuits on identity, so re-dispatching the same perspective is a
        // no-op. The reliable escalation: find the live MultiselectList instance via
        // React-fiber walk and directly set state.computedColumns + state._lastColumns
        // so subsequent getDerivedStateFromProps comparisons preserve the injected
        // state. Also forceUpdate ThreadList as a belt-and-suspenders measure.
        injectColumnsWithRetries(newWide);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] installOwnerRecipientColumn failed:', err);
    }
}
function serialize() { }
exports.serialize = serialize;
function deactivate() {
    // eslint-disable-next-line no-console
    console.info('[mml-engagement-spike] deactivate');
    mailspring_exports_1.ComponentRegistry.unregister(engagement_badge_1.default);
    for (const role of [
        'ThreadActionsToolbarButton',
        'ThreadList:Toolbar',
        'MessageList:Toolbar',
        'MessageListHeaders',
        'ThreadList:ToolbarButton',
    ]) {
        try {
            mailspring_exports_1.ComponentRegistry.unregister(disposition_toolbar_1.default);
        }
        catch (e) { }
    }
    for (const role of [
        'MessageHeader',
        'MessageList:Header',
        'MessageItem:Header',
        'MessageListHeader',
    ]) {
        try {
            mailspring_exports_1.ComponentRegistry.unregister(tldr_overlay_1.default);
        }
        catch (e) { }
    }
    removeStyleTag();
    sortPatch.deactivate();
    sort_cycle_handler_1.unregisterSortCycleCommand();
    unregisterKeymaps();
    tag_keystroke_handler_1.unregisterTagCommands();
    note_keystroke_handler_1.unregisterNoteCommand();
    event_keystroke_handler_1.unregisterEventCommand();
    routed_keystroke_handler_1.unregisterRoutedCommands();
    sort_view_handler_1.unregisterSortViewCommand();
    accept_suggestion_handler_1.unregisterAcceptCommand();
    auto_intake_1.deactivate();
    sidebar_extension_1.deactivate();
    id_hud_handler_1.unregisterIdHud();
}
exports.deactivate = deactivate;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9tYWluLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsMkRBRzRCO0FBRTVCLDBFQUFpRDtBQUNqRCxnRkFBdUQ7QUFDdkQsa0VBQXlDO0FBQ3pDLG9GQUEwRDtBQUMxRCwrREFBcUU7QUFDckUsbUVBQXFGO0FBQ3JGLHFFQUFzRjtBQUN0Rix1RUFBeUY7QUFDekYseUVBQThGO0FBQzlGLDJEQUF5RjtBQUN6Riw2REFBNEY7QUFDNUYsMkVBQTZGO0FBQzdGLHFEQUFrRTtBQUNsRSxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7QUFDMUMsK0NBR3VCO0FBQ3ZCLDJEQUc2QjtBQUU3Qix3RUFBd0U7QUFDeEUscUVBQXFFO0FBQ3JFLHdFQUF3RTtBQUN4RSx5RUFBeUU7QUFDekUsd0RBQXdEO0FBQ3hELHdFQUF3RTtBQUV4RSx3RUFBd0U7QUFDeEUscUVBQXFFO0FBQ3JFLGdFQUFnRTtBQUNoRSx3RUFBd0U7QUFFeEUsTUFBTSxZQUFZLEdBQUcseUJBQXlCLENBQUM7QUFDL0MsTUFBTSxTQUFTLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0ErTmpCLENBQUM7QUFFRixTQUFTLGVBQWU7SUFDdEIsSUFBSSxPQUFPLFFBQVEsS0FBSyxXQUFXO1FBQUUsT0FBTztJQUM1QyxJQUFJLFFBQVEsQ0FBQyxjQUFjLENBQUMsWUFBWSxDQUFDO1FBQUUsT0FBTztJQUNsRCxNQUFNLEdBQUcsR0FB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