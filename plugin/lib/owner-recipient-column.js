"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
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
class OwnerRecipientColumn extends mailspring_exports_1.React.Component {
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
        if (prev !== curr)
            this._refresh();
    }
    _refresh() {
        const { thread } = this.props;
        if (!thread || !thread.id)
            return;
        this._lastThreadId = thread.id;
        sidecarClient.getThreadForMailspringThread(thread)
            .then(state => {
            if (!this._mounted)
                return;
            if (this._lastThreadId !== thread.id)
                return;
            this.setState({ markAddr: state ? state.to_me_addr || null : null });
        })
            .catch(() => {
            if (!this._mounted)
                return;
            this.setState({ markAddr: null });
        });
    }
    render() {
        const { markAddr } = this.state;
        if (!markAddr) {
            return (mailspring_exports_1.React.createElement("span", { className: "mml-owner-recipient-col mml-owner-recipient-empty", title: "No owner-recipient data" }, "\u00B7"));
        }
        return (mailspring_exports_1.React.createElement("span", { className: "mml-owner-recipient-col", title: markAddr }, markAddr));
    }
}
exports.default = OwnerRecipientColumn;
OwnerRecipientColumn.displayName = 'OwnerRecipientColumn';
OwnerRecipientColumn.propTypes = { thread: mailspring_exports_1.PropTypes.object };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFyay1yZWNpcGllbnQtY29sdW1uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21hcmstcmVjaXBpZW50LWNvbHVtbi5qc3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSwyREFBc0Q7QUFFdEQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFFbEQsNEJBQTRCO0FBQzVCLEVBQUU7QUFDRiw2RUFBNkU7QUFDN0UsMEVBQTBFO0FBQzFFLDRFQUE0RTtBQUM1RSwyRUFBMkU7QUFDM0UsRUFBRTtBQUNGLHNFQUFzRTtBQUN0RSx3RUFBd0U7QUFFeEUsTUFBcUIsbUJBQW9CLFNBQVEsMEJBQUssQ0FBQyxTQUFTO0lBSTlELFlBQVksS0FBSztRQUNmLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNiLElBQUksQ0FBQyxLQUFLLEdBQUcsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFDaEMsSUFBSSxDQUFDLFFBQVEsR0FBRyxLQUFLLENBQUM7UUFDdEIsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUM7SUFDNUIsQ0FBQztJQUVELGlCQUFpQjtRQUNmLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDO1FBQ3JCLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztJQUNsQixDQUFDO0lBRUQsb0JBQW9CLEtBQUssSUFBSSxDQUFDLFFBQVEsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBRWpELGtCQUFrQixDQUFDLFNBQVM7UUFDMUIsTUFBTSxJQUFJLEdBQUcsU0FBUyxJQUFJLFNBQVMsQ0FBQyxNQUFNLElBQUksU0FBUyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDbEUsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3ZELElBQUksSUFBSSxLQUFLLElBQUk7WUFBRSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7SUFDckMsQ0FBQztJQUVELFFBQVE7UUFDTixNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUM5QixJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUU7WUFBRSxPQUFPO1FBQ2xDLElBQUksQ0FBQyxhQUFhLEdBQUcsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUMvQixhQUFhLENBQUMsNEJBQTRCLENBQUMsTUFBTSxDQUFDO2FBQy9DLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRTtZQUNaLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUTtnQkFBRSxPQUFPO1lBQzNCLElBQUksSUFBSSxDQUFDLGFBQWEsS0FBSyxNQUFNLENBQUMsRUFBRTtnQkFBRSxPQUFPO1lBQzdDLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsWUFBWSxJQUFJLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUN6RSxDQUFDLENBQUM7YUFDRCxLQUFLLENBQUMsR0FBRyxFQUFFO1lBQ1YsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRO2dCQUFFLE9BQU87WUFDM0IsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBQ3BDLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztJQUVELE1BQU07UUFDSixNQUFNLEVBQUUsUUFBUSxFQUFFLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztRQUNoQyxJQUFJLENBQUMsUUFBUSxFQUFFO1lBQ2IsT0FBTyxDQUNMLG1EQUFNLFNBQVMsRUFBQyxpREFBaUQsRUFBQyxLQUFLLEVBQUMsd0JBQXdCLGFBRXpGLENBQ1IsQ0FBQztTQUNIO1FBQ0QsT0FBTyxDQUNMLG1EQUNFLFNBQVMsRUFBQyx3QkFBd0IsRUFDbEMsS0FBSyxFQUFFLFFBQVEsSUFFZCxRQUFRLENBQ0osQ0FDUixDQUFDO0lBQ0osQ0FBQzs7QUF6REgsc0NBMERDO0FBekRRLCtCQUFXLEdBQUcscUJBQXFCLENBQUM7QUFDcEMsNkJBQVMsR0FBRyxFQUFFLE1BQU0sRUFBRSw4QkFBUyxDQUFDLE1BQU0sRUFBRSxDQUFDIn0=