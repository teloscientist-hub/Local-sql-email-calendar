import { React, PropTypes } from 'mailspring-exports';

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

export default class PersonBand extends React.Component {
  static displayName = 'PersonBand';

  static propTypes = {
    rating: PropTypes.number.isRequired,
  };

  render() {
    const { rating } = this.props;
    if (typeof rating !== 'number' || rating < 1 || rating > 9) return null;
    const color = PALETTE[rating] || PALETTE[1];
    return (
      <span
        className={`mml-person-band mml-rating-${rating}`}
        title={`Rating: ${rating}/9`}
        style={{ background: color }}
      >
        {rating}
      </span>
    );
  }
}
