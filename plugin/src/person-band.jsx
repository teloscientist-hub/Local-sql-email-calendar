import { React, PropTypes } from 'mailspring-exports';
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

export default class PersonBand extends React.Component {
  static displayName = 'PersonBand';

  static propTypes = {
    rating: PropTypes.number.isRequired,
  };

  render() {
    const { rating } = this.props;
    if (typeof rating !== 'number' || rating < 1 || rating > 9) return null;
    return (
      <span
        className={`mml-person-band mml-rating-${rating}`}
        title={`Rating: ${rating}/9`}
        style={{ background: colorForRating(rating) }}
      >
        {rating}
      </span>
    );
  }
}
