import { CategoryStore, MailboxPerspective } from 'mailspring-exports';
import * as path from 'path';

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

const ROUTED_PARENT      = 'Routed';
const ROUTED_PREFIX      = 'Routed/';
const ROUTED_ID          = 'mml-routed-unified';
const ROUTED_INSERT_AT   = 1;

const PROCESSING_PARENT     = 'Processing';
const PROCESSING_ID         = 'mml-processing-unified';
const PROCESSING_INSERT_AT  = 1;
// Preserve the workflow order the owner thinks in: pending → waiting → complete,
// then fun as the side bucket. NOT alphabetical.
const PROCESSING_CHILDREN   = ['Pending', 'Waiting', 'Complete', 'Fun'];

let SidebarStore = null;
let SidebarItem = null;
let SidebarSection = null;
let originalStandardSectionForAccounts = null;

function resolveInternals() {
  if (SidebarStore && SidebarItem && SidebarSection) return;
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
    const cats = CategoryStore.categories(acc.id) || [];
    for (const c of cats) {
      const dn = (c && c.displayName) || '';
      if (dn === ROUTED_PARENT) {
        allRouted.push(c);
      } else if (dn.startsWith(ROUTED_PREFIX)) {
        allRouted.push(c);
        const suffix = dn.slice(ROUTED_PREFIX.length);
        if (suffix.length === 0) continue;
        if (!byChild.has(suffix)) byChild.set(suffix, []);
        byChild.get(suffix).push(c);
      }
    }
  }
  if (allRouted.length === 0) return null;

  const names = Array.from(byChild.keys()).sort((a, b) => a.localeCompare(b));
  const children = names.map((name) =>
    SidebarItem.forCategories(byChild.get(name), {
      name,
      editable: false,
      deletable: false,
    })
  );

  return SidebarItem.forPerspective(
    ROUTED_ID,
    MailboxPerspective.forCategories(allRouted),
    { name: ROUTED_PARENT, iconName: 'folder.png', children }
  );
}

function buildUnifiedProcessingItem(accounts) {
  const byChild = new Map(); // exact displayName → Category[]
  const allCats = [];
  const childSet = new Set(PROCESSING_CHILDREN);
  for (const acc of accounts) {
    const cats = CategoryStore.categories(acc.id) || [];
    for (const c of cats) {
      const dn = (c && c.displayName) || '';
      if (childSet.has(dn)) {
        allCats.push(c);
        if (!byChild.has(dn)) byChild.set(dn, []);
        byChild.get(dn).push(c);
      }
    }
  }
  if (allCats.length === 0) return null;

  // Preserve workflow order, not alphabetical.
  const children = PROCESSING_CHILDREN
    .filter((name) => byChild.has(name))
    .map((name) =>
      SidebarItem.forCategories(byChild.get(name), {
        name,
        editable: false,
        deletable: false,
      })
    );

  return SidebarItem.forPerspective(
    PROCESSING_ID,
    MailboxPerspective.forCategories(allCats),
    { name: PROCESSING_PARENT, iconName: 'tag.png', children }
  );
}

function injectInto(section, accounts) {
  if (!section || !Array.isArray(section.items)) return;
  // Strip any prior injections (this function may run repeatedly).
  section.items = section.items.filter(
    (i) => i && i.id !== ROUTED_ID && i.id !== PROCESSING_ID
  );

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

export function activate() {
  try {
    resolveInternals();
  } catch (err) {
    console.warn('[mml-productivity] could not resolve Mailspring sidebar internals:', err);
    return;
  }
  if (originalStandardSectionForAccounts) return;

  originalStandardSectionForAccounts =
    SidebarSection.standardSectionForAccounts.bind(SidebarSection);

  SidebarSection.standardSectionForAccounts = function patchedStandardSectionForAccounts(accounts) {
    const section = originalStandardSectionForAccounts(accounts);
    try {
      injectInto(section, accounts || []);
    } catch (err) {
      console.warn('[mml-productivity] unified-sidebar injection failed:', err);
    }
    return section;
  };

  try {
    SidebarStore._updateSections();
  } catch (err) {
    console.warn('[mml-productivity] forced sidebar refresh failed:', err);
  }
}

export function deactivate() {
  if (originalStandardSectionForAccounts && SidebarSection) {
    SidebarSection.standardSectionForAccounts = originalStandardSectionForAccounts;
    try { SidebarStore._updateSections(); } catch (e) {}
  }
  SidebarStore = null;
  SidebarItem = null;
  SidebarSection = null;
  originalStandardSectionForAccounts = null;
}
