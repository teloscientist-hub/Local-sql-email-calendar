"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const person_band_1 = __importDefault(require("./person-band"));
const category_tag_1 = __importDefault(require("./category-tag"));
const content_marker_1 = __importDefault(require("./content-marker"));
const sidecarClient = require('./sidecar-client');
// engagement-badge.jsx
//
// Phase 3 — three-layer triage badge. Replaces the Phase 1 hash-stub.
//
// Render flow per ThreadListIcon row:
//   1. Resolve thread → array of RFC-822 Message-IDs (cached).
//   2. Fetch ThreadState from sidecar /thread (cached, 200ms timeout).
//   3. Pick layer:
//        Layer 1 (Person tier)   if rating >= 1   → <PersonBand />
//        Layer 2 (Category tag)  else if cluster_id IN [1..28] excluding
//                                fall-through {29,30,31}/{38} and not
//                                already shown by L1 → <CategoryTag />
//        Layer 3 (Content)       else if tldr_text non-null → <ContentMarker />
//        else → blank (returns null, ~95–99% of rows).
//
// Default for unknown / sidecar-down → blank. The badge silent-fails
// rather than rendering an error indicator.
const FALL_THROUGH_CLUSTER_IDS = new Set([29, 30, 31, 38]);
// Minimum rating that earns a visible PersonBand. Manual ratings of 1 are
// rare; this floor avoids cluttering the slot with low-tier digits the
// owner didn't intentionally type. Lower if you want explicit 1s to surface.
const PERSON_BAND_MIN_RATING = 1;
// Only these rating sources represent a deliberate, person-level signal
// the owner put into the system. Cluster-default ratings (and zero) are
// suppressed regardless of value — they're auto-derived fallbacks, not
// statements about a person.
const PERSON_LEVEL_SOURCES = new Set([
    'manual',
    'csv',
    'priority_friend',
    'family',
]);
function pickLayer(state) {
    if (!state)
        return 'blank';
    const { rating, rating_source, cluster_id, tldr_text } = state;
    if (typeof rating === 'number'
        && rating >= PERSON_BAND_MIN_RATING
        && PERSON_LEVEL_SOURCES.has(rating_source)) {
        return 'person';
    }
    if (typeof cluster_id === 'number'
        && cluster_id >= 1
        && !FALL_THROUGH_CLUSTER_IDS.has(cluster_id)) {
        return 'category';
    }
    if (typeof tldr_text === 'string' && tldr_text.length > 0) {
        return 'content';
    }
    return 'blank';
}
class EngagementBadge extends mailspring_exports_1.React.Component {
    constructor(props) {
        super(props);
        this.state = { threadState: null, loading: false };
        this._mounted = false;
        this._lastThreadId = null;
    }
    componentDidMount() {
        this._mounted = true;
        this._refresh();
    }
    componentWillUnmount() {
        this._mounted = false;
    }
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
        this.setState({ loading: true });
        sidecarClient.getThreadForMailspringThread(thread)
            .then(state => {
            if (!this._mounted)
                return;
            if (this._lastThreadId !== thread.id)
                return; // raced — drop
            this.setState({ threadState: state, loading: false });
        })
            .catch(() => {
            if (!this._mounted)
                return;
            this.setState({ threadState: null, loading: false });
        });
    }
    render() {
        const { threadState } = this.state;
        const layer = pickLayer(threadState);
        if (layer === 'blank')
            return null;
        if (layer === 'person') {
            return mailspring_exports_1.React.createElement(person_band_1.default, { rating: threadState.rating });
        }
        if (layer === 'category') {
            return (mailspring_exports_1.React.createElement(category_tag_1.default, { clusterId: threadState.cluster_id, clusterName: threadState.cluster_name }));
        }
        if (layer === 'content') {
            return mailspring_exports_1.React.createElement(content_marker_1.default, { importanceScore: threadState.importance_score });
        }
        return null;
    }
}
exports.default = EngagementBadge;
EngagementBadge.displayName = 'EngagementBadge';
EngagementBadge.propTypes = {
    thread: mailspring_exports_1.PropTypes.object,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5nYWdlbWVudC1iYWRnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9lbmdhZ2VtZW50LWJhZGdlLmpzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDJEQUFzRDtBQUN0RCxnRUFBdUM7QUFDdkMsa0VBQXlDO0FBQ3pDLHNFQUE2QztBQUU3QyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsa0JBQWtCLENBQUMsQ0FBQztBQUVsRCx1QkFBdUI7QUFDdkIsRUFBRTtBQUNGLHNFQUFzRTtBQUN0RSxFQUFFO0FBQ0Ysc0NBQXNDO0FBQ3RDLCtEQUErRDtBQUMvRCx1RUFBdUU7QUFDdkUsbUJBQW1CO0FBQ25CLG1FQUFtRTtBQUNuRSx5RUFBeUU7QUFDekUsc0VBQXNFO0FBQ3RFLHVFQUF1RTtBQUN2RSxnRkFBZ0Y7QUFDaEYsdURBQXVEO0FBQ3ZELEVBQUU7QUFDRixxRUFBcUU7QUFDckUsNENBQTRDO0FBRTVDLE1BQU0sd0JBQXdCLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBRTNELDBFQUEwRTtBQUMxRSx3RUFBd0U7QUFDeEUsdUVBQXVFO0FBQ3ZFLE1BQU0sc0JBQXNCLEdBQUcsQ0FBQyxDQUFDO0FBRWpDLHdFQUF3RTtBQUN4RSxtRUFBbUU7QUFDbkUsdUVBQXVFO0FBQ3ZFLDZCQUE2QjtBQUM3QixNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ25DLFFBQVE7SUFDUixLQUFLO0lBQ0wsaUJBQWlCO0lBQ2pCLFFBQVE7Q0FDVCxDQUFDLENBQUM7QUFFSCxTQUFTLFNBQVMsQ0FBQyxLQUFLO0lBQ3RCLElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxPQUFPLENBQUM7SUFFM0IsTUFBTSxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxHQUFHLEtBQUssQ0FBQztJQUUvRCxJQUFJ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