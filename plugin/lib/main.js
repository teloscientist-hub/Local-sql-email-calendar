"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const engagement_badge_1 = __importDefault(require("./engagement-badge"));
const disposition_toolbar_1 = __importDefault(require("./disposition-toolbar"));
const tldr_overlay_1 = __importDefault(require("./tldr-overlay"));
const owner_recipient_column_1 = __importDefault(require("./owner-recipient-column"));
const engagement_stub_1 = require("./engagement-stub");
const disposition_actions_1 = require("./disposition-actions");
const tag_keystroke_handler_1 = require("./tag-keystroke-handler");
const note_keystroke_handler_1 = require("./note-keystroke-handler");
const event_keystroke_handler_1 = require("./event-keystroke-handler");
const routed_keystroke_handler_1 = require("./routed-keystroke-handler");
const accept_suggestion_handler_1 = require("./accept-suggestion-handler");
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

  /* ----- Owner-recipient column (its own real ListTabular column) ----- */
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
// Increment B — sort monkey-patch (paths 1, 2). See spike plan §B.
// Path 1 (public API) — log what's available at activate(). Path 2
// (monkey-patch) — wrap MailboxPerspective.prototype.threads to
// post-sort the resolved ModelQuery results by engagementForThread desc.
// By patching the PROTOTYPE we cover every MailboxPerspective subclass.
// =====================================================================
const __originalThreads = mailspring_exports_1.MailboxPerspective.prototype.threads;
function logSortApiSurface() {
    const surface = {
        hasMailboxPerspectiveThreads: typeof __originalThreads === 'function',
        workspaceStoreLayoutMode: mailspring_exports_1.WorkspaceStore && mailspring_exports_1.WorkspaceStore.layoutMode && mailspring_exports_1.WorkspaceStore.layoutMode(),
        perspectiveSubclasses: Object.keys(mailspring_exports_1.MailboxPerspective || {}).filter(k => /[Pp]erspective$/.test(k)),
    };
    // eslint-disable-next-line no-console
    console.info('[mml-engagement-spike] sort API surface:', surface);
}
function postSortByEngagement(threads) {
    if (!Array.isArray(threads) || threads.length === 0)
        return threads;
    return threads
        .map((t, i) => ({ t, i, e: engagement_stub_1.engagementForThread(t) }))
        .sort((a, b) => (b.e - a.e) || (a.i - b.i))
        .map(x => x.t);
}
let __patchInvocationCount = 0;
function patchedThreads(...args) {
    const query = __originalThreads.apply(this, args);
    if (!query)
        return query;
    __patchInvocationCount += 1;
    if (__patchInvocationCount <= 3) {
        // eslint-disable-next-line no-console
        console.info('[mml-engagement-spike] patchedThreads invoked', {
            perspectiveCtor: this && this.constructor && this.constructor.name,
            hasThen: typeof query.then === 'function',
            hasSubscribe: typeof query.subscribe === 'function',
            hasObserve: typeof query.observe === 'function',
            queryKeys: Object.keys(query || {}).slice(0, 25),
        });
    }
    // Wrap .then() — for any consumer that awaits the query as a Promise.
    if (typeof query.then === 'function') {
        const originalThen = query.then.bind(query);
        query.then = (onResolve, onReject) => {
            return originalThen((results) => {
                try {
                    const sorted = postSortByEngagement(results);
                    return onResolve ? onResolve(sorted) : sorted;
                }
                catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('[mml-engagement-spike] post-sort (then) error:', err);
                    return onResolve ? onResolve(results) : results;
                }
            }, onReject);
        };
    }
    // Wrap .subscribe() — Mailspring's thread list uses observable subscribe,
    // not .then(). subscribe(callback) | subscribe({next, error, complete}).
    if (typeof query.subscribe === 'function') {
        const originalSubscribe = query.subscribe.bind(query);
        query.subscribe = (cbOrObserver) => {
            const wrap = (results) => {
                try {
                    return postSortByEngagement(results);
                }
                catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('[mml-engagement-spike] post-sort (subscribe) error:', err);
                    return results;
                }
            };
            if (typeof cbOrObserver === 'function') {
                return originalSubscribe((results) => cbOrObserver(wrap(results)));
            }
            if (cbOrObserver && typeof cbOrObserver.next === 'function') {
                const wrapped = Object.assign({}, cbOrObserver, {
                    next: (results) => cbOrObserver.next(wrap(results)),
                });
                return originalSubscribe(wrapped);
            }
            return originalSubscribe(cbOrObserver);
        };
    }
    // Wrap .observe() — alternate name some Mailspring versions use.
    if (typeof query.observe === 'function') {
        const originalObserve = query.observe.bind(query);
        query.observe = (cb) => {
            return originalObserve((results) => {
                try {
                    cb(postSortByEngagement(results));
                }
                catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('[mml-engagement-spike] post-sort (observe) error:', err);
                    cb(results);
                }
            });
        };
    }
    return query;
}
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
    'mml-engagement-spike:move-to-later': 'Later',
    'mml-engagement-spike:move-to-later-alt': 'Later',
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
        'Try Cmd+Shift+1..4 (Pending/Waiting/Complete/Later) or Cmd+Opt+1..4.');
    return true;
}
function registerKeymapsFallback() {
    const codeToFolder = {
        'Digit1': 'Pending',
        'Digit2': 'Waiting',
        'Digit3': 'Complete',
        'Digit4': 'Later',
    };
    // Diagnostic without-DevTools: every keydown updates document.title with
    // a short summary of modifiers + e.code. The owner can read their own keystrokes
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
    // Increment B
    logSortApiSurface();
    mailspring_exports_1.MailboxPerspective.prototype.threads = patchedThreads;
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
let __ownerRecipientColumnInstalled = false;
function installOwnerRecipientColumn() {
    if (__ownerRecipientColumnInstalled)
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
            __ownerRecipientColumnInstalled = true;
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
            resolver: (thread) => mailspring_exports_1.React.createElement(owner_recipient_column_1.default, { thread }),
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
        __ownerRecipientColumnInstalled = true;
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
    mailspring_exports_1.MailboxPerspective.prototype.threads = __originalThreads;
    unregisterKeymaps();
    tag_keystroke_handler_1.unregisterTagCommands();
    note_keystroke_handler_1.unregisterNoteCommand();
    event_keystroke_handler_1.unregisterEventCommand();
    routed_keystroke_handler_1.unregisterRoutedCommands();
    accept_suggestion_handler_1.unregisterAcceptCommand();
    auto_intake_1.deactivate();
    sidebar_extension_1.deactivate();
}
exports.deactivate = deactivate;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9tYWluLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsMkRBSzRCO0FBRTVCLDBFQUFpRDtBQUNqRCxnRkFBdUQ7QUFDdkQsa0VBQXlDO0FBQ3pDLG9GQUEwRDtBQUMxRCx1REFBd0Q7QUFDeEQsK0RBQXFFO0FBQ3JFLG1FQUFxRjtBQUNyRixxRUFBc0Y7QUFDdEYsdUVBQXlGO0FBQ3pGLHlFQUE4RjtBQUM5RiwyRUFBNkY7QUFDN0YsK0NBR3VCO0FBQ3ZCLDJEQUc2QjtBQUU3Qix3RUFBd0U7QUFDeEUscUVBQXFFO0FBQ3JFLHdFQUF3RTtBQUN4RSx5RUFBeUU7QUFDekUsd0RBQXdEO0FBQ3hELHdFQUF3RTtBQUV4RSx3RUFBd0U7QUFDeEUscUVBQXFFO0FBQ3JFLGdFQUFnRTtBQUNoRSx3RUFBd0U7QUFFeEUsTUFBTSxZQUFZLEdBQUcseUJBQXlCLENBQUM7QUFDL0MsTUFBTSxTQUFTLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWdNakIsQ0FBQztBQUVGLFNBQVMsZUFBZTtJQUN0QixJQUFJLE9BQU8sUUFBUSxLQUFLLFdBQVc7UUFBRSxPQUFPO0lBQzVDLElBQUksUUFBUSxDQUFDLGNBQWMsQ0FBQyxZQUFZLENBQUM7UUFBRSxPQUFPO0lBQ2xELE1BQU0sR0FBRyxHQUFHLFFBQVEsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDNUMsR0FBRyxDQUFDLEVBQUUsR0FBRyxZQUFZLENBQUM7SUFDdEIsR0FBRyxDQUFDLFdBQVcsQ0FBQyxRQUFR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