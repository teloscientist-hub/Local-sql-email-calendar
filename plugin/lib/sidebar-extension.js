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
// sidebar section, each aggregating same-named categories across both
// accounts. Mailspring's `ExtensionRegistry.AccountSidebar` hook forces
// children-by-account (sidebar-section.ts:147-156). We need children-by-
// name, so we monkey-patch the internal `SidebarSection.standardSectionForAccounts`.
//
//   Processing — top-level disposition folders Pending/Waiting/Complete/Fun.
//                Inserted at index 1 (above Unread).
//   Routed     — Routed/<8 names> categories.
//                Inserted at index 1; after Processing splices in, lands at
//                index 2 (above Unread, below Processing).
const ROUTED_PARENT = 'Routed';
const ROUTED_PREFIX = 'Routed/';
const ROUTED_ID = 'mml-routed-unified';
const ROUTED_INSERT_AT = 1;
const PROCESSING_PARENT = 'Processing';
const PROCESSING_ID = 'mml-processing-unified';
const PROCESSING_INSERT_AT = 1;
// Preserve the workflow order the owner thinks in: pending → waiting → complete,
// then fun as the side bucket. NOT alphabetical.
const PROCESSING_CHILDREN = ['Pending', 'Waiting', 'Complete', 'Fun'];
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
    // Processing inserted at index 1 — pushes Routed/Unread/Starred down by
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2lkZWJhci1leHRlbnNpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvc2lkZWJhci1leHRlbnNpb24uanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7O0FBQUEsMkRBQXVFO0FBQ3ZFLDJDQUE2QjtBQUU3Qix5RUFBeUU7QUFDekUsc0VBQXNFO0FBQ3RFLHdFQUF3RTtBQUN4RSx5RUFBeUU7QUFDekUscUZBQXFGO0FBQ3JGLEVBQUU7QUFDRiw2RUFBNkU7QUFDN0UscURBQXFEO0FBQ3JELDhDQUE4QztBQUM5Qyw0RUFBNEU7QUFDNUUsMkRBQTJEO0FBRTNELE1BQU0sYUFBYSxHQUFRLFFBQVEsQ0FBQztBQUNwQyxNQUFNLGFBQWEsR0FBUSxTQUFTLENBQUM7QUFDckMsTUFBTSxTQUFTLEdBQVksb0JBQW9CLENBQUM7QUFDaEQsTUFBTSxnQkFBZ0IsR0FBSyxDQUFDLENBQUM7QUFFN0IsTUFBTSxpQkFBaUIsR0FBTyxZQUFZLENBQUM7QUFDM0MsTUFBTSxhQUFhLEdBQVcsd0JBQXdCLENBQUM7QUFDdkQsTUFBTSxvQkFBb0IsR0FBSSxDQUFDLENBQUM7QUFDaEMsNEVBQTRFO0FBQzVFLGlEQUFpRDtBQUNqRCxNQUFNLG1CQUFtQixHQUFLLENBQUMsU0FBUyxFQUFFLFNBQVMsRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFFeEUsSUFBSSxZQUFZLEdBQUcsSUFBSSxDQUFDO0FBQ3hCLElBQUksV0FBVyxHQUFHLElBQUksQ0FBQztBQUN2QixJQUFJLGNBQWMsR0FBRyxJQUFJLENBQUM7QUFDMUIsSUFBSSxrQ0FBa0MsR0FBRyxJQUFJLENBQUM7QUFFOUMsU0FBUyxnQkFBZ0I7SUFDdkIsSUFBSSxZQUFZLElBQUksV0FBVyxJQUFJLGNBQWM7UUFBRSxPQUFPO0lBQzFELE1BQU0sRUFBRSxZQUFZLEVBQUUsR0FBRyxNQUFNLENBQUMsZUFBZSxFQUFFLENBQUM7SUFDbEQsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFD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