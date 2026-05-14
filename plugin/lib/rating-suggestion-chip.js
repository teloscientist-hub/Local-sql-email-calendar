"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const { colorForRating } = require('./rating-colors');
// rating-suggestion-chip.jsx
//
// Phase 6.0.f — LLM-suggested 0..9 rating, rendered as a hex pill so it
// reads visually distinct from a manual PersonBand (round pill). Same
// color palette as PersonBand — only the shape differs, signaling
// "system guess" vs "your decision."
//
// Slots between PersonBand and CategoryTag in engagement-badge.jsx's
// dispatch: appears only when no person-level rating exists and the
// rating classifier has produced a suggestion >= 1 for at least one
// message in the thread.
class RatingSuggestionChip extends mailspring_exports_1.React.Component {
    render() {
        const { rating, confidence, reason, clusterName } = this.props;
        if (typeof rating !== 'number' || rating < 1 || rating > 9)
            return null;
        const lines = [`LLM rating: ${rating}/9`];
        if (typeof confidence === 'number' && Number.isFinite(confidence)) {
            lines.push(`Confidence: ${Math.round(confidence * 100)}%`);
        }
        if (clusterName)
            lines.push(`Cluster: ${clusterName}`);
        if (reason)
            lines.push(reason);
        const title = lines.join('\n');
        return (mailspring_exports_1.React.createElement("span", { className: `mml-rating-chip mml-rating-${rating}`, title: title, style: { background: colorForRating(rating) } }, rating));
    }
}
exports.default = RatingSuggestionChip;
RatingSuggestionChip.displayName = 'RatingSuggestionChip';
RatingSuggestionChip.propTypes = {
    rating: mailspring_exports_1.PropTypes.number.isRequired,
    confidence: mailspring_exports_1.PropTypes.number,
    reason: mailspring_exports_1.PropTypes.string,
    clusterName: mailspring_exports_1.PropTypes.string,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmF0aW5nLXN1Z2dlc3Rpb24tY2hpcC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9yYXRpbmctc3VnZ2VzdGlvbi1jaGlwLmpzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDJEQUFzRDtBQUN0RCxNQUFNLEVBQUUsY0FBYyxFQUFFLEdBQUcsT0FBTyxDQUFDLGlCQUFpQixDQUFDLENBQUM7QUFFdEQsNkJBQTZCO0FBQzdCLEVBQUU7QUFDRix3RUFBd0U7QUFDeEUsc0VBQXNFO0FBQ3RFLGtFQUFrRTtBQUNsRSxxQ0FBcUM7QUFDckMsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSxvRUFBb0U7QUFDcEUsb0VBQW9FO0FBQ3BFLHlCQUF5QjtBQUV6QixNQUFxQixvQkFBcUIsU0FBUSwwQkFBSyxDQUFDLFNBQVM7SUFVL0QsTUFBTTtRQUNKLE1BQU0sRUFBRSxNQUFNLEVBQUUsVUFBVSxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUUsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDO1FBQy9ELElBQUksT0FBTyxNQUFNLEtBQUssUUFBUSxJQUFJLE1BQU0sR0FBRyxDQUFDLElBQUksTUFBTSxHQUFHLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUV4RSxNQUFNLEtBQUssR0FBRyxDQUFDLGVBQWUsTUFBTSxJQUFJLENBQUMsQ0FBQztRQUMxQyxJQUFJLE9BQU8sVUFBVSxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxFQUFFO1lBQ2pFLEtBQUssQ0FBQyxJQUFJLENBQUMsZUFBZSxJQUFJLENBQUMsS0FBSyxDQUFDLFVBQVUsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7U0FDNUQ7UUFDRCxJQUFJLFdBQVc7WUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLFlBQVksV0FBVyxFQUFFLENBQUMsQ0FBQztRQUN2RCxJQUFJLE1BQU07WUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQy9CLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFL0IsT0FBTyxDQUNMLG1EQUNFLFNBQVMsRUFBRSw4QkFBOEIsTUFBTSxFQUFFLEVBQ2pELEtBQUssRUFBRSxLQUFLLEVBQ1osS0FBSyxFQUFFLEVBQUUsVUFBVSxFQUFFLGNBQWMsQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUU1QyxNQUFNLENBQ0YsQ0FDUixDQUFDO0lBQ0osQ0FBQzs7QUEvQkgsdUNBZ0NDO0FBL0JRLGdDQUFXLEdBQUcsc0JBQXNCLENBQUM7QUFFckMsOEJBQVMsR0FBRztJQUNqQixNQUFNLEVBQUUsOEJBQVMsQ0FBQyxNQUFNLENBQUMsVUFBVTtJQUNuQyxVQUFVLEVBQUUsOEJBQVMsQ0FBQyxNQUFNO0lBQzVCLE1BQU0sRUFBRSw4QkFBUyxDQUFDLE1BQU07SUFDeEIsV0FBVyxFQUFFLDhCQUFTLENBQUMsTUFBTTtDQUM5QixDQUFDIn0=