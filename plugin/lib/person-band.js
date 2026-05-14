"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const { colorForRating } = require('./rating-colors');
// person-band.jsx
//
// Layer 1 of the three-layer triage: a colored band/dot whose hue and
// saturation scale with the per-contact rating (1-9). Renders in the
// ThreadListIcon slot. ~1% of inbox rows. Default rendering is a small
// rounded rectangle showing the digit (so the owner can read a precise rating
// at a glance without needing to memorize the color ramp).
//
// Palette is shared with RatingSuggestionChip via ./rating-colors.
class PersonBand extends mailspring_exports_1.React.Component {
    render() {
        const { rating } = this.props;
        if (typeof rating !== 'number' || rating < 1 || rating > 9)
            return null;
        return (mailspring_exports_1.React.createElement("span", { className: `mml-person-band mml-rating-${rating}`, title: `Rating: ${rating}/9`, style: { background: colorForRating(rating) } }, rating));
    }
}
exports.default = PersonBand;
PersonBand.displayName = 'PersonBand';
PersonBand.propTypes = {
    rating: mailspring_exports_1.PropTypes.number.isRequired,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGVyc29uLWJhbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvcGVyc29uLWJhbmQuanN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsMkRBQXNEO0FBQ3RELE1BQU0sRUFBRSxjQUFjLEVBQUUsR0FBRyxPQUFPLENBQUMsaUJBQWlCLENBQUMsQ0FBQztBQUV0RCxrQkFBa0I7QUFDbEIsRUFBRTtBQUNGLHNFQUFzRTtBQUN0RSxxRUFBcUU7QUFDckUsdUVBQXVFO0FBQ3ZFLHlFQUF5RTtBQUN6RSwyREFBMkQ7QUFDM0QsRUFBRTtBQUNGLG1FQUFtRTtBQUVuRSxNQUFxQixVQUFXLFNBQVEsMEJBQUssQ0FBQyxTQUFTO0lBT3JELE1BQU07UUFDSixNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUM5QixJQUFJLE9BQU8sTUFBTSxLQUFLLFFBQVEsSUFBSSxNQUFNLEdBQUcsQ0FBQyxJQUFJLE1BQU0sR0FBRyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDeEUsT0FBTyxDQUNMLG1EQUNFLFNBQVMsRUFBRSw4QkFBOEIsTUFBTSxFQUFFLEVBQ2pELEtBQUssRUFBRSxXQUFXLE1BQU0sSUFBSSxFQUM1QixLQUFLLEVBQUUsRUFBRSxVQUFVLEVBQUUsY0FBYyxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBRTVDLE1BQU0sQ0FDRixDQUNSLENBQUM7SUFDSixDQUFDOztBQW5CSCw2QkFvQkM7QUFuQlEsc0JBQVcsR0FBRyxZQUFZLENBQUM7QUFFM0Isb0JBQVMsR0FBRztJQUNqQixNQUFNLEVBQUUsOEJBQVMsQ0FBQyxNQUFNLENBQUMsVUFBVTtDQUNwQyxDQUFDIn0=