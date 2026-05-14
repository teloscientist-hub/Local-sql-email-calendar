import { React, PropTypes } from 'mailspring-exports';

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

export default class ContentMarker extends React.Component {
  static displayName = 'ContentMarker';

  static propTypes = {
    importanceScore: PropTypes.number,
  };

  render() {
    const { importanceScore } = this.props;
    if (typeof importanceScore !== 'number' || importanceScore < 0.6) return null;
    return (
      <span
        className="mml-content-marker"
        title={`Content importance: ${importanceScore.toFixed(2)}`}
      />
    );
  }
}
