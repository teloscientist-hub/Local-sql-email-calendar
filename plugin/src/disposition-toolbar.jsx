import { React, PropTypes } from 'mailspring-exports';
import { moveSelectedTo, DISPOSITIONS } from './disposition-actions';

// Increment C: a row of disposition buttons rendered in the thread-actions
// toolbar. Each button moves the currently-selected thread(s) into a named
// destination folder via ChangeFoldersTask.
//
// Mailspring renders ThreadActionsToolbarButton components in a horizontal
// row; we ship one component that draws all four buttons inline so they
// share one ToolbarItem slot and stay grouped together.

const BUTTON_LABELS = {
  Pending:  '⏳ Pending',
  Waiting:  '⏸ Waiting',
  Complete: '✓ Complete',
  Fun:      '★ Fun',
};

const BUTTON_KEYHINT = {
  Pending:  '⌘⇧1',
  Waiting:  '⌘⇧2',
  Complete: '⌘⇧3',
  Fun:      '⌘⇧4',
};

export default class DispositionToolbar extends React.Component {
  static displayName = 'DispositionToolbar';

  static propTypes = {
    items: PropTypes.array,  // Array<Thread> — Mailspring injects the
                             // currently-selected threads into items.
  };

  _onClick = (folderName) => () => {
    const items = (this.props.items || []).filter(Boolean);
    moveSelectedTo(folderName, items);
  };

  render() {
    const items = (this.props.items || []).filter(Boolean);
    const disabled = items.length === 0;
    return (
      <div className="mml-disposition-toolbar" style={{ display: 'inline-flex', gap: 4 }}>
        {DISPOSITIONS.map(name => (
          <button
            key={name}
            className="btn btn-toolbar"
            disabled={disabled}
            title={`Move to ${name}  (${BUTTON_KEYHINT[name]})`}
            onClick={this._onClick(name)}
          >
            {BUTTON_LABELS[name]}
          </button>
        ))}
      </div>
    );
  }
}
