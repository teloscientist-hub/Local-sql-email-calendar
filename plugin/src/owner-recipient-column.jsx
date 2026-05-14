import { React, PropTypes } from 'mailspring-exports';

const sidecarClient = require('./sidecar-client');

// owner-recipient-column.jsx
//
// Renders inside a real (monkey-patched) ListTabular column showing which of
// the owner's email addresses received this thread. One component instance per
// thread row; each does its own /thread fetch, but sidecar-client.js caches
// at the RFC-ID-set level so re-fetches for already-seen threads are free.
//
// Display rule: full email address (e.g., 'mark@gameofthriving.com').
// Column width is set to fit typical the owner-addresses; overflow ellipses.

export default class OwnerRecipientColumn extends React.Component {
  static displayName = 'OwnerRecipientColumn';
  static propTypes = { thread: PropTypes.object };

  constructor(props) {
    super(props);
    this.state = { markAddr: null };
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
        this.setState({ markAddr: state ? state.to_me_addr || null : null });
      })
      .catch(() => {
        if (!this._mounted) return;
        this.setState({ markAddr: null });
      });
  }

  render() {
    const { markAddr } = this.state;
    if (!markAddr) {
      return (
        <span className="mml-owner-recipient-col mml-owner-recipient-empty" title="No owner-recipient data">
          ·
        </span>
      );
    }
    return (
      <span
        className="mml-owner-recipient-col"
        title={markAddr}
      >
        {markAddr}
      </span>
    );
  }
}
