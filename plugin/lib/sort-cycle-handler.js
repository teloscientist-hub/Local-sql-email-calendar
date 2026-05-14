"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
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
function registerSortCycleCommand() {
    try {
        _disposable = AppEnv.commands.add(document.body, 'mml-productivity:cycle-sort', () => {
            // eslint-disable-next-line no-console
            console.info('[mml-productivity] command fired: mml-productivity:cycle-sort');
            cycleSort();
        });
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] registered cycle-sort command. Try Cmd+Shift+S.');
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] failed to register cycle-sort command:', err);
    }
}
exports.registerSortCycleCommand = registerSortCycleCommand;
function unregisterSortCycleCommand() {
    if (_disposable && _disposable.dispose) {
        try {
            _disposable.dispose();
        }
        catch (_e) { /* noop */ }
    }
    _disposable = null;
}
exports.unregisterSortCycleCommand = unregisterSortCycleCommand;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29ydC1jeWNsZS1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NvcnQtY3ljbGUtaGFuZGxlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsd0JBQXdCO0FBQ3hCLEVBQUU7QUFDRixrRUFBa0U7QUFDbEUscUVBQXFFO0FBQ3JFLHFFQUFxRTtBQUNyRSw4REFBOEQ7QUFDOUQsRUFBRTtBQUNGLHNFQUFzRTtBQUN0RSx5RUFBeUU7QUFDekUsd0VBQXdFO0FBQ3hFLDZEQUE2RDs7QUFFN0QsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0FBRTFDLElBQUksV0FBVyxHQUFHLElBQUksQ0FBQztBQUV2QixTQUFTLE1BQU0sQ0FBQyxJQUFJLEVBQUUsRUFBRSxHQUFHLElBQUk7SUFDN0IsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQztJQUNoQyxRQUFRLENBQUMsS0FBSyxHQUFHLFNBQVMsSUFBSSxFQUFFLENBQUM7SUFDakMsVUFBVSxDQUFDLEdBQUcsRUFBRSxHQUFHLFFBQVEsQ0FBQyxLQUFLLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ3ZELENBQUM7QUFFRCxTQUFTLFNBQVM7SUFDaEIsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQ2hDLE1BQU0sQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLENBQUM7SUFDekIsc0NBQXNDO0lBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMsc0JBQXNCLEdBQUcsS0FBSyxDQUFDLENBQUM7QUFDL0MsQ0FBQztBQUVELFNBQWdCLHdCQUF3QjtJQUN0QyxJQUFJO1FBQ0YsV0FBVyxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUMvQixRQUFRLENBQUMsSUFBSSxFQUNiLDZCQUE2QixFQUM3QixHQUFHLEVBQUU7WUFDSCxzQ0FBc0M7WUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQywrREFBK0QsQ0FBQyxDQUFDO1lBQzlFLFNBQVMsRUFBRSxDQUFDO1FBQ2QsQ0FBQyxDQUNGLENBQUM7UUFDRixzQ0FBc0M7UUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyxvRUFBb0UsQ0FBQyxDQUFDO0tBQ3BGO0lBQUMsT0FBTyxHQUFHLEVBQUU7UUFDWixzQ0FBc0M7UUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQywyREFBMkQsRUFBRSxHQUFHLENBQUMsQ0FBQztLQUNoRjtBQUNILENBQUM7QUFqQkQsNERBaUJDO0FBRUQsU0FBZ0IsMEJBQTBCO0lBQ3hDLElBQUksV0FBVyxJQUFJLFdBQVcsQ0FBQyxPQUFPLEVBQUU7UUFDdEMsSUFBSTtZQUFFLFdBQVcsQ0FBQyxPQUFPLEVBQUUsQ0FBQztTQUFFO1FBQUMsT0FBTyxFQUFFLEVBQUUsRUFBRSxVQUFVLEVBQUU7S0FDekQ7SUFDRCxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3JCLENBQUM7QUFMRCxnRUFLQyJ9