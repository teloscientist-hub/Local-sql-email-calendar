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
  1: '#d8d8d8',  // gray
  2: '#b8d4e8',  // cool muted
  3: '#a4c8e8',  // cool
  4: '#8eb6df',  // cooler-saturated
  5: '#79b08c',  // green-shift, mid
  6: '#c8b66c',  // yellow, warming
  7: '#d99454',  // orange
  8: '#d96d54',  // red-orange
  9: '#c83838',  // vivid red
};

function colorForRating(rating) {
  return PALETTE[rating] || PALETTE[1];
}

module.exports = { PALETTE, colorForRating };
