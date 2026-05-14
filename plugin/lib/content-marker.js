"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
// content-marker.jsx
//
// Layer 3 of the three-layer triage: a tiny dot indicating a fall-through
// cluster message (newsletter / transactional / cold pitch) with an
// importance_score above the TLDR threshold. the owner sees the dot in the
// thread list and the full TLDR overlay above the message body when he
// opens it. <1% of inbox rows.
//
// `tldr_text` non-null on the sidecar response already implies
// `importance_score >= 0.6` (the prompt enforces this). The badge uses
// tldr_text presence as the trigger here — no plugin-side threshold check.
class ContentMarker extends mailspring_exports_1.React.Component {
    render() {
        const { importanceScore } = this.props;
        if (typeof importanceScore !== 'number' || importanceScore < 0.6)
            return null;
        return (mailspring_exports_1.React.createElement("span", { className: "mml-content-marker", title: `Content importance: ${importanceScore.toFixed(2)}` }));
    }
}
exports.default = ContentMarker;
ContentMarker.displayName = 'ContentMarker';
ContentMarker.propTypes = {
    importanceScore: mailspring_exports_1.PropTypes.number,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvY29udGVudC1tYXJrZXIuanN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsMkRBQXNEO0FBRXRELHFCQUFxQjtBQUNyQixFQUFFO0FBQ0YsMEVBQTBFO0FBQzFFLG9FQUFvRTtBQUNwRSxzRUFBc0U7QUFDdEUsdUVBQXVFO0FBQ3ZFLCtCQUErQjtBQUMvQixFQUFFO0FBQ0YsK0RBQStEO0FBQy9ELHVFQUF1RTtBQUN2RSwyRUFBMkU7QUFFM0UsTUFBcUIsYUFBYyxTQUFRLDBCQUFLLENBQUMsU0FBUztJQU94RCxNQUFNO1FBQ0osTUFBTSxFQUFFLGVBQWUsRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUM7UUFDdkMsSUFBSSxPQUFPLGVBQWUsS0FBSyxRQUFRLElBQUksZUFBZSxHQUFHLEdBQUc7WUFBRSxPQUFPLElBQUksQ0FBQztRQUM5RSxPQUFPLENBQ0wsbURBQ0UsU0FBUyxFQUFDLG9CQUFvQixFQUM5QixLQUFLLEVBQUUsdUJBQXVCLGVBQWUsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FDMUQsQ0FDSCxDQUFDO0lBQ0osQ0FBQzs7QUFoQkgsZ0NBaUJDO0FBaEJRLHlCQUFXLEdBQUcsZUFBZSxDQUFDO0FBRTlCLHVCQUFTLEdBQUc7SUFDakIsZUFBZSxFQUFFLDhCQUFTLENBQUMsTUFBTTtDQUNsQyxDQUFDIn0=