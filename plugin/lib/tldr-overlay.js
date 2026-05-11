"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const sidecarClient = require('./sidecar-client');
// tldr-overlay.jsx
//
// Phase 3 — bordered TLDR box rendered ABOVE a message body. Source
// mail is never modified. Visible only when the sidecar's content
// scorer has produced a `tldr_text` for the message (which the prompt
// gates at importance_score >= 0.6, so non-null tldr_text is sufficient
// signal — no plugin-side threshold check).
//
// Mailspring registers components against `MessageHeader` (and a few
// related roles) for content above a message body. main.js registers
// this component against the most likely role; if the slot doesn't fire
// at runtime, swap in a different role and rebuild.
//
// Per-message render: read the thread state for this message's
// headerMessageId only (a list of one) and check tldr_text. We use
// the per-thread cache so multiple per-message calls within the same
// thread share the same network round-trip.
class TldrOverlay extends mailspring_exports_1.React.Component {
    constructor(props) {
        super(props);
        this._onDismiss = () => {
            this.setState({ dismissed: true });
        };
        this.state = { state: null, dismissed: false };
        this._mounted = false;
    }
    componentDidMount() {
        this._mounted = true;
        this._refresh();
    }
    componentWillUnmount() {
        this._mounted = false;
    }
    componentDidUpdate(prev) {
        const a = prev && prev.message && prev.message.id;
        const b = this.props.message && this.props.message.id;
        if (a !== b) {
            this.setState({ dismissed: false });
            this._refresh();
        }
    }
    _refresh() {
        const { message } = this.props;
        if (!message || !message.headerMessageId)
            return;
        sidecarClient.getThreadByRfcIds([message.headerMessageId])
            .then(state => {
            if (!this._mounted)
                return;
            this.setState({ state });
        })
            .catch(() => { });
    }
    render() {
        const { state, dismissed } = this.state;
        if (dismissed)
            return null;
        if (!state)
            return null;
        const { tldr_text, importance_score } = state;
        if (typeof tldr_text !== 'string' || tldr_text.length === 0)
            return null;
        return (mailspring_exports_1.React.createElement("div", { className: "mml-tldr-overlay" },
            mailspring_exports_1.React.createElement("div", { className: "mml-tldr-header" },
                mailspring_exports_1.React.createElement("span", { className: "mml-tldr-label" }, "TLDR"),
                typeof importance_score === 'number' && (mailspring_exports_1.React.createElement("span", { className: "mml-tldr-score" }, `importance ${importance_score.toFixed(2)}`)),
                mailspring_exports_1.React.createElement("button", { type: "button", className: "mml-tldr-dismiss", onClick: this._onDismiss, title: "Dismiss for this session" }, "\u00D7")),
            mailspring_exports_1.React.createElement("div", { className: "mml-tldr-body" }, tldr_text)));
    }
}
exports.default = TldrOverlay;
TldrOverlay.displayName = 'TldrOverlay';
TldrOverlay.propTypes = {
    message: mailspring_exports_1.PropTypes.object,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGxkci1vdmVybGF5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3RsZHItb3ZlcmxheS5qc3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSwyREFBc0Q7QUFFdEQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFFbEQsbUJBQW1CO0FBQ25CLEVBQUU7QUFDRixvRUFBb0U7QUFDcEUsa0VBQWtFO0FBQ2xFLHNFQUFzRTtBQUN0RSx3RUFBd0U7QUFDeEUsNENBQTRDO0FBQzVDLEVBQUU7QUFDRixxRUFBcUU7QUFDckUscUVBQXFFO0FBQ3JFLHdFQUF3RTtBQUN4RSxvREFBb0Q7QUFDcEQsRUFBRTtBQUNGLCtEQUErRDtBQUMvRCxtRUFBbUU7QUFDbkUscUVBQXFFO0FBQ3JFLDRDQUE0QztBQUU1QyxNQUFxQixXQUFZLFNBQVEsMEJBQUssQ0FBQyxTQUFTO0lBT3RELFlBQVksS0FBSztRQUNmLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztRQWtDZixlQUFVLEdBQUcsR0FBRyxFQUFFO1lBQ2hCLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUNyQyxDQUFDLENBQUM7UUFuQ0EsSUFBSSxDQUFDLEtBQUssR0FBRyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBRSxDQUFDO1FBQy9DLElBQUksQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDO0lBQ3hCLENBQUM7SUFFRCxpQkFBaUI7UUFDZixJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQztRQUNyQixJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7SUFDbEIsQ0FBQztJQUVELG9CQUFvQjtRQUNsQixJQUFJLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQztJQUN4QixDQUFDO0lBRUQsa0JBQWtCLENBQUMsSUFBSTtRQUNyQixNQUFNLENBQUMsR0FBRyxJQUFJLElBQUksSUFBSSxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztRQUNsRCxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7UUFDdEQsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFO1lBQ1gsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLFNBQVMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO1lBQ3BDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztTQUNqQjtJQUNILENBQUM7SUFFRCxRQUFRO1FBQ04sTUFBTSxFQUFFLE9BQU8sRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUM7UUFDL0IsSUFBSSxDQUFDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxlQUFlO1lBQUUsT0FBTztRQUNqRCxhQUFhLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxPQUFPLENBQUMsZUFBZSxDQUFDLENBQUM7YUFDdkQsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFO1lBQ1osSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRO2dCQUFFLE9BQU87WUFDM0IsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDM0IsQ0FBQyxDQUFDO2FBQ0QsS0FBSyxDQUFDLEdBQUcsRUFBRSxHQUFxQixDQUFDLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBTUQsTUFBTTtRQUNKLE1BQU0sRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUN4QyxJQUFJLFNBQVM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUMzQixJQUFJLENBQUMsS0FBSztZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ3hCLE1BQU0sRUFBRSxTQUFTLEVBQUUsZ0JBQWdCLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFDOUMsSUFBSSxPQUFPLFNBQVMsS0FBSyxRQUFRLElBQUksU0FBUyxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFFekUsT0FBTyxDQUNMLGtEQUFLLFNBQVMsRUFBQyxrQkFBa0I7WUFDL0Isa0RBQUssU0FBUyxFQUFDLGlCQUFpQjtnQkFDOUIsbURBQU0sU0FBUyxFQUFDLGdCQUFnQixXQUFZO2dCQUMzQyxPQUFPLGdCQUFnQixLQUFLLFFBQVEsSUFBSSxDQUN2QyxtREFBTSxTQUFTLEVBQUMsZ0JBQWdCLElBQzdCLGNBQWMsZ0JBQWdCLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQ3ZDLENBQ1I7Z0JBQ0QscURBQ0UsSUFBSSxFQUFDLFFBQVEsRUFDYixTQUFTLEVBQUMsa0JBQWtCLEVBQzVCLE9BQU8sRUFBRSxJQUFJLENBQUMsVUFBVSxFQUN4QixLQUFLLEVBQUMsMEJBQTBCLGFBR3pCLENBQ0w7WUFDTixrREFBSyxTQUFTLEVBQUMsZUFBZSxJQUFFLFNBQVMsQ0FBTyxDQUM1QyxDQUNQLENBQUM7SUFDSixDQUFDOztBQTFFSCw4QkEyRUM7QUExRVEsdUJBQVcsR0FBRyxhQUFhLENBQUM7QUFFNUIscUJBQVMsR0FBRztJQUNqQixPQUFPLEVBQUUsOEJBQVMsQ0FBQyxNQUFNO0NBQzFCLENBQUMifQ==