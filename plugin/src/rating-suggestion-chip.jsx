import { React, PropTypes } from 'mailspring-exports';
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

export default class RatingSuggestionChip extends React.Component {
  static displayName = 'RatingSuggestionChip';

  static propTypes = {
    rating: PropTypes.number.isRequired,
    confidence: PropTypes.number,
    reason: PropTypes.string,
    clusterName: PropTypes.string,
  };

  render() {
    const { rating, confidence, reason, clusterName } = this.props;
    if (typeof rating !== 'number' || rating < 1 || rating > 9) return null;

    const lines = [`LLM rating: ${rating}/9`];
    if (typeof confidence === 'number' && Number.isFinite(confidence)) {
      lines.push(`Confidence: ${Math.round(confidence * 100)}%`);
    }
    if (clusterName) lines.push(`Cluster: ${clusterName}`);
    if (reason) lines.push(reason);
    const title = lines.join('\n');

    return (
      <span
        className={`mml-rating-chip mml-rating-${rating}`}
        title={title}
        style={{ background: colorForRating(rating) }}
      >
        {rating}
      </span>
    );
  }
}
