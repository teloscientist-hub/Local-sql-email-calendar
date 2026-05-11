import { React, PropTypes } from 'mailspring-exports';

const sidecarClient = require('./sidecar-client');

// owner-recipient-column.jsx
//
// Renders inside a real (monkey-patched) ListTabular column showing which of
// the owner's email addresses received this thread. One component instance
// per thread row; each does its own /thread fetch, but sidecar-client.js
// caches at the RFC-ID-set level so re-fetches for already-seen threads are
// free.
//
// Display rule: full email address. The string comes from the sidecar's
// `to_me_addr` field, which is looked up against the `me_addresses` SQL
// table (one row per email address the owner uses to receive mail).
// Column width is set to fit typical addresses; overflow ellipses.

export default class OwnerRecipientColumn extends React.Component {
  static displayName = 'OwnerRecipientColumn';
  static propTypes = { thread: PropTypes.object };

  constructor(props) {
    super(props);
    this.state = { ownerAddr: null };
    this._mounted = false;
    this._lastThreadId = null;
  }

  componentDidMount() {
    this._mounted = true;
    this._refresh();
  }

  componentWillUnmount() { this._mounted = false; }

  componentDidUpdate(prevProps) {
    const prev = prevProps && prevProps.thread && prevProps.thread.id;
    const curr = this.props.thread && this.props.thread.id;
    if (prev !== curr) this._refresh();
  }

  _refresh() {
    const { thread } = this.props;
    if (!thread || !thread.id) return;
    this._lastThreadId = thread.id;
    sidecarClient.getThreadForMailspringThread(thread)
      .then(state => {
        if (!this._mounted) return;
        if (this._lastThreadId !== thread.id) return;
        this.setState({ ownerAddr: state ? state.to_me_addr || null : null });
      })
      .catch(() => {
        if (!this._mounted) return;
        this.setState({ ownerAddr: null });
      });
  }

  render() {
    const { ownerAddr } = this.state;
    if (!ownerAddr) {
      return (
        <span className="mml-owner-recipient-col mml-owner-recipient-empty" title="No owner-recipient data">
          ·
        </span>
      );
    }
    return (
      <span
        className="mml-owner-recipient-col"
        title={ownerAddr}
      >
        {ownerAddr}
      </span>
    );
  }
}
