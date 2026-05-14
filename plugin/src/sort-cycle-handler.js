// sort-cycle-handler.js
//
// Phase 1 — keystroke control surface for the sticky native sort.
// Cmd+Shift+S cycles through the dimensions defined in sort-patch.js
// and shows a brief toast (via document.title) indicating the active
// sort. Same toast pattern as event-keystroke-handler.js etc.
//
// Why this chord: Cmd+Option+<letter> is densely occupied by Routed/*
// (mml-routed.json) including Cmd+Option+S = route-to-smm; Ctrl+Option+*
// is owned by tag-N (rating chords). Cmd+Shift+S is unbound in both the
// plugin's keymaps and Mailspring's base keymaps as of 1.21.

const sortPatch = require('./sort-patch');

let _disposable = null;

function _toast(text, ms = 2200) {
  const original = document.title;
  document.title = `[mml] ${text}`;
  setTimeout(() => { document.title = original; }, ms);
}

function cycleSort() {
  const label = sortPatch.cycle();
  _toast('Sort: ' + label);
  // eslint-disable-next-line no-console
  console.info('[mml-sort] cycled → ' + label);
}

export function registerSortCycleCommand() {
  try {
    _disposable = AppEnv.commands.add(
      document.body,
      'mml-productivity:cycle-sort',
      () => {
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] command fired: mml-productivity:cycle-sort');
        cycleSort();
      },
    );
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] registered cycle-sort command. Try Cmd+Shift+S.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] failed to register cycle-sort command:', err);
  }
}

export function unregisterSortCycleCommand() {
  if (_disposable && _disposable.dispose) {
    try { _disposable.dispose(); } catch (_e) { /* noop */ }
  }
  _disposable = null;
}
