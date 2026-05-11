import { React, PropTypes } from 'mailspring-exports';

// category-tag.jsx
//
// Layer 2 of the three-layer triage: a small gray text tag for messages
// that have a non-fall-through cluster but no per-contact rating. ~1–3%
// of inbox rows. The label is the cluster name from the sidecar (the
// plugin doesn't maintain its own cluster ID → name table — sidecar's
// thread_lookup returns the live cluster name for the most-recently-
// classified message in the thread).
//
// Layer 1 (PersonBand) suppresses Layer 2 — when a person-tier rating
// applies, we render the band and skip the tag.

// Short labels for the common clusters. Sidecar's cluster_name is
// long-form (e.g. "Newsletters / lists"); we render the first 4 chars of
// the name by default, or a short manual abbreviation if listed below.
//
// Populate after running the taxonomy generator (see
// docs/CLASSIFICATION_TAXONOMY.md). Map cluster_id → short label (≤6
// chars works best in the badge slot). Example:
//   const SHORT_LABELS = { 1: 'Friend', 3: 'Fam', 29: 'News', ... };
const SHORT_LABELS = {};

function pickLabel(clusterId, clusterName) {
  if (clusterId in SHORT_LABELS) return SHORT_LABELS[clusterId];
  if (typeof clusterName === 'string' && clusterName.length > 0) {
    // Strip "/ ..." suffix and take the first word, max 6 chars.
    const head = clusterName.split(/[/(]/)[0].trim();
    const word = head.split(/\s+/)[0] || head;
    return word.slice(0, 6);
  }
  return '·';
}

export default class CategoryTag extends React.Component {
  static displayName = 'CategoryTag';

  static propTypes = {
    clusterId: PropTypes.number,
    clusterName: PropTypes.string,
  };

  render() {
    const { clusterId, clusterName } = this.props;
    if (typeof clusterId !== 'number') return null;
    const label = pickLabel(clusterId, clusterName);
    return (
      <span
        className="mml-category-tag"
        title={`Cluster ${clusterId}${clusterName ? `: ${clusterName}` : ''}`}
      >
        {label}
      </span>
    );
  }
}
