// disposition-actions.js
//
// Shared helper for moving the currently-selected thread(s) into a named
// destination folder/label. Called from BOTH the toolbar buttons
// (Increment C) and the keymap handlers (Increment D), so they always
// behave identically.
//
// The move recipe is copied from Mailspring's own category-picker
// (internal_packages/category-picker/lib/move-picker-popover.js, the
// _onMoveToCategory handler):
//
//   - Destination is a Folder (IMAP/Zoho): ChangeFolderTask, single
//     folder move. Class is `ChangeFolderTask` (singular!), not
//     `ChangeFoldersTask`.
//   - Destination is a Label (Gmail):       ChangeLabelsTask,
//     removing ALL existing labels (which includes Inbox) and adding
//     the destination label. The thread fully leaves Inbox.
//
// Folder discovery: CategoryStore.categories(account) is matched by
// `displayName` against `folderName`. The owner pre-creates the four
// disposition folders/labels in each provider's web UI; the plugin only
// looks them up by name.

import {
  Actions,
  AccountStore,
  CategoryStore,
  ChangeFolderTask,
  ChangeLabelsTask,
  Folder,
  ThreadListStore,
  FocusedContentStore,
} from 'mailspring-exports';

// Mailspring's thread-list-store auto-focuses the NEXT-OLDER thread after
// a move (it prefers an unread previous neighbor; in a busy inbox that's
// almost always the next-older thread, which moves the user backward in
// time). This helper finds the next-NEWER unmoved thread BEFORE we queue
// the task, and pre-emptively focuses it. Once the data change arrives,
// the auto-focus heuristic sees `focused` is still in the next dataSource
// and leaves it alone.
function _findNextNewerThread(threadsBeingMoved) {
  try {
    if (!ThreadListStore || typeof ThreadListStore.dataSource !== 'function') return null;
    const ds = ThreadListStore.dataSource();
    if (!ds || typeof ds.offsetOfId !== 'function' || typeof ds.modelAtOffset !== 'function') {
      return null;
    }
    const movingIds = new Set(
      (threadsBeingMoved || []).map((t) => t && t.id).filter(Boolean)
    );
    if (movingIds.size === 0) return null;
    // Lowest index among moved threads = newest moved thread.
    let minIndex = Infinity;
    for (const id of movingIds) {
      const idx = ds.offsetOfId(id);
      if (idx >= 0 && idx < minIndex) minIndex = idx;
    }
    if (!Number.isFinite(minIndex)) return null;
    // Walk upward (newer) until we hit a thread NOT being moved.
    for (let i = minIndex - 1; i >= 0; i--) {
      const candidate = ds.modelAtOffset(i);
      if (candidate && !movingIds.has(candidate.id)) return candidate;
    }
    return null;
  } catch (_err) {
    return null;
  }
}

// Note: 'Complete' (not 'Done') because Gmail reserves the label name
// 'Done' for system use and refuses to let users create it. We use the
// same vocabulary across both providers for consistency.
//
// These are the GTD-flavored top-level disposition folders. Rename
// freely — the keymap (mml-engagement-spike.json), main.js
// COMMAND_TO_FOLDER, and sidebar-extension.js PROCESSING_CHILDREN must
// stay in sync.
export const DISPOSITIONS = ['Pending', 'Waiting', 'Complete', 'Later'];

function findCategoryByName(account, name) {
  const cats = CategoryStore.categories(account) || [];
  return cats.find(c => c && c.displayName === name) || null;
}

function focusedThreads() {
  // Multi-select case first: ThreadListStore's selection.
  if (ThreadListStore && ThreadListStore.dataSource) {
    const ds = ThreadListStore.dataSource();
    if (ds && ds.selection) {
      const sel = ds.selection.items();
      if (sel && sel.length > 0) return sel;
    }
  }
  // Single focused thread fallback.
  const focused = FocusedContentStore.focused('thread');
  return focused ? [focused] : [];
}

export function moveSelectedTo(folderName, explicitThreads) {
  const threads = (explicitThreads && explicitThreads.length > 0)
    ? explicitThreads
    : focusedThreads();
  if (!threads || threads.length === 0) {
    // eslint-disable-next-line no-console
    console.info(`[mml-engagement-spike] moveSelectedTo(${folderName}): no threads selected.`);
    return { queued: 0, skipped: 0 };
  }

  // Capture the next-newer thread BEFORE the move so we can pre-empt
  // Mailspring's "prefer older unread" auto-focus heuristic.
  const nextNewer = _findNextNewerThread(threads);

  // Group by accountId — one task per account.
  const byAccount = {};
  for (const t of threads) {
    if (!t || !t.accountId) continue;
    (byAccount[t.accountId] = byAccount[t.accountId] || []).push(t);
  }

  let queued = 0;
  let skipped = 0;

  for (const accountId of Object.keys(byAccount)) {
    const account = AccountStore.accountForId(accountId);
    if (!account) {
      skipped += byAccount[accountId].length;
      continue;
    }
    const dest = findCategoryByName(account, folderName);
    if (!dest) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mml-engagement-spike] No "${folderName}" folder/label in account ` +
        `${account.emailAddress}. Pre-create it in the provider's web UI.`
      );
      skipped += byAccount[accountId].length;
      continue;
    }
    const accountThreads = byAccount[accountId];

    let task;
    if (dest instanceof Folder) {
      // IMAP / non-Gmail folder.
      task = new ChangeFolderTask({
        source: 'mml-engagement-spike',
        threads: accountThreads,
        folder: dest,
      });
    } else {
      // Gmail label. Remove all current labels (including Inbox), apply dest.
      const labelsToRemove = [];
      for (const t of accountThreads) {
        if (t && Array.isArray(t.labels)) {
          for (const l of t.labels) labelsToRemove.push(l);
        }
      }
      task = new ChangeLabelsTask({
        source: 'mml-engagement-spike',
        threads: accountThreads,
        labelsToAdd: [dest],
        labelsToRemove,
      });
    }
    Actions.queueTask(task);
    queued += accountThreads.length;
  }

  // eslint-disable-next-line no-console
  console.info(
    `[mml-engagement-spike] moveSelectedTo(${folderName}): queued=${queued} skipped=${skipped}`
  );

  // Pre-empt the auto-focus heuristic with the next-newer unmoved thread.
  // Mailspring updates the thread list either synchronously via performLocal
  // (optimistic) or after mailsync confirms (~1-2s). In either case its
  // _onDataChanged heuristic prefers the next-OLDER thread, so we set focus
  // multiple times across a 1.5s window to win the race regardless of when
  // the heuristic fires.
  // eslint-disable-next-line no-console
  console.info(
    `[mml-productivity] post-move focus → ${
      nextNewer ? `thread ${nextNewer.id} (${(nextNewer.subject||'').slice(0,40)})` : '(none — newest moved or list empty)'
    }`
  );
  if (queued > 0 && nextNewer) {
    const setBoth = () => {
      try {
        Actions.setFocus({ collection: 'thread', item: nextNewer });
        Actions.setCursorPosition({ collection: 'thread', item: nextNewer });
      } catch (_e) { /* noop */ }
    };
    // Three shots: immediately (before optimistic update), after the
    // current callstack (after optimistic update), and after mailsync ack.
    setBoth();
    setTimeout(setBoth, 50);
    setTimeout(setBoth, 1500);
  }

  return { queued, skipped };
}
