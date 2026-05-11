import { React, PropTypes } from 'mailspring-exports';

const sidecarClient = require('./sidecar-client');

// tldr-overlay.jsx
//
// Phase 3 — bordered TLDR box rendered ABOVE a message body. Source
// mail is never modified. Visible only when the sidecar's content
// scorer has produced a `tldr_text` for the message (which the prompt
// gates at importance_score >= 0.6, so non-null tldr_text is sufficient
// signal — no plugin-side threshold check).
//
// Mailspring registers components against `MessageHeader` (and a few
// related roles) for content above a message body. main.js registers
// this component against the most likely role; if the slot doesn't fire
// at runtime, swap in a different role and rebuild.
//
// Per-message render: read the thread state for this message's
// headerMessageId only (a list of one) and check tldr_text. We use
// the per-thread cache so multiple per-message calls within the same
// thread share the same network round-trip.

export default class TldrOverlay extends React.Component {
  static displayName = 'TldrOverlay';

  static propTypes = {
    message: PropTypes.object,
  };

  constructor(props) {
    super(props);
    this.state = { state: null, dismissed: false };
    this._mounted = false;
  }

  componentDidMount() {
    this._mounted = true;
    this._refresh();
  }

  componentWillUnmount() {
    this._mounted = false;
  }

  componentDidUpdate(prev) {
    const a = prev && prev.message && prev.message.id;
    const b = this.props.message && this.props.message.id;
    if (a !== b) {
      this.setState({ dismissed: false });
      this._refresh();
    }
  }

  _refresh() {
    const { message } = this.props;
    if (!message || !message.headerMessageId) return;
    sidecarClient.getThreadByRfcIds([message.headerMessageId])
      .then(state => {
        if (!this._mounted) return;
        this.setState({ state });
      })
      .catch(() => { /* silent fail */ });
  }

  _onDismiss = () => {
    this.setState({ dismissed: true });
  };

  render() {
    const { state, dismissed } = this.state;
    if (dismissed) return null;
    if (!state) return null;
    const { tldr_text, importance_score } = state;
    if (typeof tldr_text !== 'string' || tldr_text.length === 0) return null;

    return (
      <div className="mml-tldr-overlay">
        <div className="mml-tldr-header">
          <span className="mml-tldr-label">TLDR</span>
          {typeof importance_score === 'number' && (
            <span className="mml-tldr-score">
              {`importance ${importance_score.toFixed(2)}`}
            </span>
          )}
          <button
            type="button"
            className="mml-tldr-dismiss"
            onClick={this._onDismiss}
            title="Dismiss for this session"
          >
            ×
          </button>
        </div>
        <div className="mml-tldr-body">{tldr_text}</div>
      </div>
    );
  }
}
