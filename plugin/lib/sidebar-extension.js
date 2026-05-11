"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const path = __importStar(require("path"));
// Phase 5.5 + 5.5.6 — TWO unified parents injected into the All-Accounts
// sidebar section, each aggregating same-named categories across the
// connected accounts. Mailspring's `ExtensionRegistry.AccountSidebar` hook
// forces children-by-account. We need children-by-name, so we monkey-patch
// the internal `SidebarSection.standardSectionForAccounts`.
//
//   Processing — top-level disposition folders (see PROCESSING_CHILDREN below).
//                Inserted at index 1 (above Unread).
//   Routed     — Routed/<name> categories. Folder discovery is prefix-based
//                at runtime; folder names defined in routed-keystroke-handler.js.
//                Inserted at index 3.
//
// IMPORTANT — disposition names below (PROCESSING_CHILDREN) are the
// working-system EXAMPLE. Replace with your own and update keymaps and
// disposition-actions.js to match.
const ROUTED_PARENT = 'Routed';
const ROUTED_PREFIX = 'Routed/';
const ROUTED_ID = 'mml-routed-unified';
const ROUTED_INSERT_AT = 3;
const PROCESSING_PARENT = 'Processing';
const PROCESSING_ID = 'mml-processing-unified';
const PROCESSING_INSERT_AT = 1;
// Preserve workflow order: pending → waiting → complete, then fun as the
// side bucket. NOT alphabetical.
const PROCESSING_CHILDREN = ['Pending', 'Waiting', 'Complete', 'Later'];
let SidebarStore = null;
let SidebarItem = null;
let SidebarSection = null;
let originalStandardSectionForAccounts = null;
function resolveInternals() {
    if (SidebarStore && SidebarItem && SidebarSection)
        return;
    const { resourcePath } = AppEnv.getLoadSettings();
    const base = path.join(resourcePath, 'internal_packages', 'account-sidebar', 'lib');
    SidebarStore = require(path.join(base, 'sidebar-store')).default;
    SidebarItem = require(path.join(base, 'sidebar-item')).default;
    SidebarSection = require(path.join(base, 'sidebar-section')).default;
}
function buildUnifiedRoutedItem(accounts) {
    const byChild = new Map(); // suffix → Category[]
    const allRouted = [];
    for (const acc of accounts) {
        const cats = mailspring_exports_1.CategoryStore.categories(acc.id) || [];
        for (const c of cats) {
            const dn = (c && c.displayName) || '';
            if (dn === ROUTED_PARENT) {
                allRouted.push(c);
            }
            else if (dn.startsWith(ROUTED_PREFIX)) {
                allRouted.push(c);
                const suffix = dn.slice(ROUTED_PREFIX.length);
                if (suffix.length === 0)
                    continue;
                if (!byChild.has(suffix))
                    byChild.set(suffix, []);
                byChild.get(suffix).push(c);
            }
        }
    }
    if (allRouted.length === 0)
        return null;
    const names = Array.from(byChild.keys()).sort((a, b) => a.localeCompare(b));
    const children = names.map((name) => SidebarItem.forCategories(byChild.get(name), {
        name,
        editable: false,
        deletable: false,
    }));
    return SidebarItem.forPerspective(ROUTED_ID, mailspring_exports_1.MailboxPerspective.forCategories(allRouted), { name: ROUTED_PARENT, iconName: 'folder.png', children });
}
function buildUnifiedProcessingItem(accounts) {
    const byChild = new Map(); // exact displayName → Category[]
    const allCats = [];
    const childSet = new Set(PROCESSING_CHILDREN);
    for (const acc of accounts) {
        const cats = mailspring_exports_1.CategoryStore.categories(acc.id) || [];
        for (const c of cats) {
            const dn = (c && c.displayName) || '';
            if (childSet.has(dn)) {
                allCats.push(c);
                if (!byChild.has(dn))
                    byChild.set(dn, []);
                byChild.get(dn).push(c);
            }
        }
    }
    if (allCats.length === 0)
        return null;
    // Preserve workflow order, not alphabetical.
    const children = PROCESSING_CHILDREN
        .filter((name) => byChild.has(name))
        .map((name) => SidebarItem.forCategories(byChild.get(name), {
        name,
        editable: false,
        deletable: false,
    }));
    return SidebarItem.forPerspective(PROCESSING_ID, mailspring_exports_1.MailboxPerspective.forCategories(allCats), { name: PROCESSING_PARENT, iconName: 'tag.png', children });
}
function injectInto(section, accounts) {
    if (!section || !Array.isArray(section.items))
        return;
    // Strip any prior injections (this function may run repeatedly).
    section.items = section.items.filter((i) => i && i.id !== ROUTED_ID && i.id !== PROCESSING_ID);
    // Routed first — splice at its desired index relative to Mailspring's
    // standard items.
    const routed = buildUnifiedRoutedItem(accounts || []);
    if (routed) {
        const at = Math.min(ROUTED_INSERT_AT, section.items.length);
        section.items.splice(at, 0, routed);
    }
    // Processing inserted at index 1 — pushes Unread/Starred/Routed down by
    // one, lands right below Inbox.
    const processing = buildUnifiedProcessingItem(accounts || []);
    if (processing) {
        const at = Math.min(PROCESSING_INSERT_AT, section.items.length);
        section.items.splice(at, 0, processing);
    }
}
function activate() {
    try {
        resolveInternals();
    }
    catch (err) {
        console.warn('[mml-productivity] could not resolve Mailspring sidebar internals:', err);
        return;
    }
    if (originalStandardSectionForAccounts)
        return;
    originalStandardSectionForAccounts =
        SidebarSection.standardSectionForAccounts.bind(SidebarSection);
    SidebarSection.standardSectionForAccounts = function patchedStandardSectionForAccounts(accounts) {
        const section = originalStandardSectionForAccounts(accounts);
        try {
            injectInto(section, accounts || []);
        }
        catch (err) {
            console.warn('[mml-productivity] unified-sidebar injection failed:', err);
        }
        return section;
    };
    try {
        SidebarStore._updateSections();
    }
    catch (err) {
        console.warn('[mml-productivity] forced sidebar refresh failed:', err);
    }
}
exports.activate = activate;
function deactivate() {
    if (originalStandardSectionForAccounts && SidebarSection) {
        SidebarSection.standardSectionForAccounts = originalStandardSectionForAccounts;
        try {
            SidebarStore._updateSections();
        }
        catch (e) { }
    }
    SidebarStore = null;
    SidebarItem = null;
    SidebarSection = null;
    originalStandardSectionForAccounts = null;
}
exports.deactivate = deactivate;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2lkZWJhci1leHRlbnNpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvc2lkZWJhci1leHRlbnNpb24uanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7O0FBQUEsMkRBQXVFO0FBQ3ZFLDJDQUE2QjtBQUU3Qix5RUFBeUU7QUFDekUsc0VBQXNFO0FBQ3RFLHdFQUF3RTtBQUN4RSx5RUFBeUU7QUFDekUscUZBQXFGO0FBQ3JGLEVBQUU7QUFDRiw2RUFBNkU7QUFDN0UscURBQXFEO0FBQ3JELDhDQUE4QztBQUM5QyxrRUFBa0U7QUFFbEUsTUFBTSxhQUFhLEdBQVEsUUFBUSxDQUFDO0FBQ3BDLE1BQU0sYUFBYSxHQUFRLFNBQVMsQ0FBQztBQUNyQyxNQUFNLFNBQVMsR0FBWSxvQkFBb0IsQ0FBQztBQUNoRCxNQUFNLGdCQUFnQixHQUFLLENBQUMsQ0FBQztBQUU3QixNQUFNLGlCQUFpQixHQUFPLFlBQVksQ0FBQztBQUMzQyxNQUFNLGFBQWEsR0FBVyx3QkFBd0IsQ0FBQztBQUN2RCxNQUFNLG9CQUFvQixHQUFJLENBQUMsQ0FBQztBQUNoQyw0RUFBNEU7QUFDNUUsaURBQWlEO0FBQ2pELE1BQU0sbUJBQW1CLEdBQUssQ0FBQyxTQUFTLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxLQUFLLENBQUMsQ0FBQztBQUV4RSxJQUFJLFlBQVksR0FBRyxJQUFJLENBQUM7QUFDeEIsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3ZCLElBQUksY0FBYyxHQUFHLElBQUksQ0FBQztBQUMxQixJQUFJLGtDQUFrQyxHQUFHLElBQUksQ0FBQztBQUU5QyxTQUFTLGdCQUFnQjtJQUN2QixJQUFJLFlBQVksSUFBSSxXQUFXLElBQUksY0FBYztRQUFFLE9BQU87SUFDMUQsTUFBTSxFQUFFLFlBQVksRUFBRSxHQUFHLE1BQU0sQ0FBQyxlQUFlLEVBQUUsQ0FBQztJQUNsRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFlB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