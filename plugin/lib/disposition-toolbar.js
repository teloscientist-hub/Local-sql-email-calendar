"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const disposition_actions_1 = require("./disposition-actions");
// Increment C: a row of disposition buttons rendered in the thread-actions
// toolbar. Each button moves the currently-selected thread(s) into a named
// destination folder via ChangeFoldersTask.
//
// Mailspring renders ThreadActionsToolbarButton components in a horizontal
// row; we ship one component that draws all four buttons inline so they
// share one ToolbarItem slot and stay grouped together.
const BUTTON_LABELS = {
    Pending: '⏳ Pending',
    Waiting: '⏸ Waiting',
    Complete: '✓ Complete',
    Fun: '★ Fun',
};
const BUTTON_KEYHINT = {
    Pending: '⌘⇧1',
    Waiting: '⌘⇧2',
    Complete: '⌘⇧3',
    Fun: '⌘⇧4',
};
class DispositionToolbar extends mailspring_exports_1.React.Component {
    constructor() {
        super(...arguments);
        this._onClick = (folderName) => () => {
            const items = (this.props.items || []).filter(Boolean);
            disposition_actions_1.moveSelectedTo(folderName, items);
        };
    }
    render() {
        const items = (this.props.items || []).filter(Boolean);
        const disabled = items.length === 0;
        return (mailspring_exports_1.React.createElement("div", { className: "mml-disposition-toolbar", style: { display: 'inline-flex', gap: 4 } }, disposition_actions_1.DISPOSITIONS.map(name => (mailspring_exports_1.React.createElement("button", { key: name, className: "btn btn-toolbar", disabled: disabled, title: `Move to ${name}  (${BUTTON_KEYHINT[name]})`, onClick: this._onClick(name) }, BUTTON_LABELS[name])))));
    }
}
exports.default = DispositionToolbar;
DispositionToolbar.displayName = 'DispositionToolbar';
DispositionToolbar.propTypes = {
    items: mailspring_exports_1.PropTypes.array,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlzcG9zaXRpb24tdG9vbGJhci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9kaXNwb3NpdGlvbi10b29sYmFyLmpzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDJEQUFzRDtBQUN0RCwrREFBcUU7QUFFckUsMkVBQTJFO0FBQzNFLDJFQUEyRTtBQUMzRSw0Q0FBNEM7QUFDNUMsRUFBRTtBQUNGLDJFQUEyRTtBQUMzRSx3RUFBd0U7QUFDeEUsd0RBQXdEO0FBRXhELE1BQU0sYUFBYSxHQUFHO0lBQ3BCLE9BQU8sRUFBRyxXQUFXO0lBQ3JCLE9BQU8sRUFBRyxXQUFXO0lBQ3JCLFFBQVEsRUFBRSxZQUFZO0lBQ3RCLEdBQUcsRUFBTyxPQUFPO0NBQ2xCLENBQUM7QUFFRixNQUFNLGNBQWMsR0FBRztJQUNyQixPQUFPLEVBQUcsS0FBSztJQUNmLE9BQU8sRUFBRyxLQUFLO0lBQ2YsUUFBUSxFQUFFLEtBQUs7SUFDZixHQUFHLEVBQU8sS0FBSztDQUNoQixDQUFDO0FBRUYsTUFBcUIsa0JBQW1CLFNBQVEsMEJBQUssQ0FBQyxTQUFTO0lBQS9EOztRQVFFLGFBQVEsR0FBRyxDQUFDLFVBQVUsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFO1lBQzlCLE1BQU0sS0FBSyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ3ZELG9DQUFjLENBQUMsVUFBVSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3BDLENBQUMsQ0FBQztJQXFCSixDQUFDO0lBbkJDLE1BQU07UUFDSixNQUFNLEtBQUssR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUN2RCxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUMsQ0FBQztRQUNwQyxPQUFPLENBQ0wsa0RBQUssU0FBUyxFQUFDLHlCQUF5QixFQUFDLEtBQUssRUFBRSxFQUFFLE9BQU8sRUFBRSxhQUFhLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxJQUMvRSxrQ0FBWSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQ3hCLHFEQUNFLEdBQUcsRUFBRSxJQUFJLEVBQ1QsU0FBUyxFQUFDLGlCQUFpQixFQUMzQixRQUFRLEVBQUUsUUFBUSxFQUNsQixLQUFLLEVBQUUsV0FBVyxJQUFJLE1BQU0sY0FBYyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQ25ELE9BQU8sRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUUzQixhQUFhLENBQUMsSUFBSSxDQUFDLENBQ2IsQ0FDVixDQUFDLENBQ0UsQ0FDUCxDQUFDO0lBQ0osQ0FBQzs7QUEvQkgscUNBZ0NDO0FBL0JRLDhCQUFXLEdBQUcsb0JBQW9CLENBQUM7QUFFbkMsNEJBQVMsR0FBRztJQUNqQixLQUFLLEVBQUUsOEJBQVMsQ0FBQyxLQUFLO0NBRXZCLENBQUMifQ==