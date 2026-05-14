// rating-colors.js
//
// Shared 1–9 color palette used by both PersonBand (filled round pill —
// the owner's own decision) and RatingSuggestionChip (hex shape — LLM's guess).
// Keeping one source of truth means the visual semantics of "rating N"
// stay consistent across both surfaces — only the shape differs.
//
// Ratings 1–4 are near-grayscale; 5–9 ramp through green/yellow/orange/red
// so warm rows pop against an otherwise cool/blank inbox.
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
function colorForRating(rating) {
    return PALETTE[rating] || PALETTE[1];
}
module.exports = { PALETTE, colorForRating };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmF0aW5nLWNvbG9ycy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9yYXRpbmctY29sb3JzLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLG1CQUFtQjtBQUNuQixFQUFFO0FBQ0Ysd0VBQXdFO0FBQ3hFLDJFQUEyRTtBQUMzRSx1RUFBdUU7QUFDdkUsaUVBQWlFO0FBQ2pFLEVBQUU7QUFDRiwyRUFBMkU7QUFDM0UsMERBQTBEO0FBRTFELE1BQU0sT0FBTyxHQUFHO0lBQ2QsQ0FBQyxFQUFFLFNBQVM7SUFDWixDQUFDLEVBQUUsU0FBUztJQUNaLENBQUMsRUFBRSxTQUFTO0lBQ1osQ0FBQyxFQUFFLFNBQVM7SUFDWixDQUFDLEVBQUUsU0FBUztJQUNaLENBQUMsRUFBRSxTQUFTO0lBQ1osQ0FBQyxFQUFFLFNBQVM7SUFDWixDQUFDLEVBQUUsU0FBUztJQUNaLENBQUMsRUFBRSxTQUFTO0NBQ2IsQ0FBQztBQUVGLFNBQVMsY0FBYyxDQUFDLE1BQU07SUFDNUIsT0FBTyxPQUFPLENBQUMsTUFBTSxDQUFDLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZDLENBQUM7QUFFRCxNQUFNLENBQUMsT0FBTyxHQUFHLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxDQUFDIn0=