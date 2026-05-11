"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
// person-band.jsx
//
// Layer 1 of the three-layer triage: a colored band/dot whose hue and
// saturation scale with the per-contact rating (1-9). Renders in the
// ThreadListIcon slot. ~1% of inbox rows. Default rendering is a small
// rounded rectangle showing the digit (so the owner can read a precise rating
// at a glance without needing to memorize the color ramp).
//
// Color palette is the Phase 3 plan suggestion. Ratings 1–4 are
// near-grayscale; 5–9 ramp through green/yellow/orange/red so warm rows
// pop against an otherwise cool/blank inbox.
const PALETTE = {
    1: '#d8d8d8',
    2: '#b8d4e8',
    3: '#a4c8e8',
    4: '#8eb6df',
    5: '#79b08c',
    6: '#c8b66c',
    7: '#d99454',
    8: '#d96d54',
    9: '#c83838',
};
class PersonBand extends mailspring_exports_1.React.Component {
    render() {
        const { rating } = this.props;
        if (typeof rating !== 'number' || rating < 1 || rating > 9)
            return null;
        const color = PALETTE[rating] || PALETTE[1];
        return (mailspring_exports_1.React.createElement("span", { className: `mml-person-band mml-rating-${rating}`, title: `Rating: ${rating}/9`, style: { background: color } }, rating));
    }
}
exports.default = PersonBand;
PersonBand.displayName = 'PersonBand';
PersonBand.propTypes = {
    rating: mailspring_exports_1.PropTypes.number.isRequired,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGVyc29uLWJhbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvcGVyc29uLWJhbmQuanN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsMkRBQXNEO0FBRXRELGtCQUFrQjtBQUNsQixFQUFFO0FBQ0Ysc0VBQXNFO0FBQ3RFLHFFQUFxRTtBQUNyRSx1RUFBdUU7QUFDdkUseUVBQXlFO0FBQ3pFLDJEQUEyRDtBQUMzRCxFQUFFO0FBQ0YsZ0VBQWdFO0FBQ2hFLHdFQUF3RTtBQUN4RSw2Q0FBNkM7QUFFN0MsTUFBTSxPQUFPLEdBQUc7SUFDZCxDQUFDLEVBQUUsU0FBUztJQUNaLENBQUMsRUFBRSxTQUFTO0lBQ1osQ0FBQyxFQUFFLFNBQVM7SUFDWixDQUFDLEVBQUUsU0FBUztJQUNaLENBQUMsRUFBRSxTQUFTO0lBQ1osQ0FBQyxFQUFFLFNBQVM7SUFDWixDQUFDLEVBQUUsU0FBUztJQUNaLENBQUMsRUFBRSxTQUFTO0lBQ1osQ0FBQyxFQUFFLFNBQVM7Q0FDYixDQUFDO0FBRUYsTUFBcUIsVUFBVyxTQUFRLDBCQUFLLENBQUMsU0FBUztJQU9yRCxNQUFNO1FBQ0osTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUM7UUFDOUIsSUFBSSxPQUFPLE1BQU0sS0FBSyxRQUFRLElBQUksTUFBTSxHQUFHLENBQUMsSUFBSSxNQUFNLEdBQUcsQ0FBQztZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ3hFLE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDNUMsT0FBTyxDQUNMLG1EQUNFLFNBQVMsRUFBRSw4QkFBOEIsTUFBTSxFQUFFLEVBQ2pELEtBQUssRUFBRSxXQUFXLE1BQU0sSUFBSSxFQUM1QixLQUFLLEVBQUUsRUFBRSxVQUFVLEVBQUUsS0FBSyxFQUFFLElBRTNCLE1BQU0sQ0FDRixDQUNSLENBQUM7SUFDSixDQUFDOztBQXBCSCw2QkFxQkM7QUFwQlEsc0JBQVcsR0FBRyxZQUFZLENBQUM7QUFFM0Isb0JBQVMsR0FBRztJQUNqQixNQUFNLEVBQUUsOEJBQVMsQ0FBQyxNQUFNLENBQUMsVUFBVTtDQUNwQyxDQUFDIn0=