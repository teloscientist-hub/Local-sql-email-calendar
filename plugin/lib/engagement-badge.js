"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
const person_band_1 = __importDefault(require("./person-band"));
const rating_suggestion_chip_1 = __importDefault(require("./rating-suggestion-chip"));
const category_tag_1 = __importDefault(require("./category-tag"));
const content_marker_1 = __importDefault(require("./content-marker"));
const sidecarClient = require('./sidecar-client');
// engagement-badge.jsx
//
// Phase 3 + 6.0.f — four-layer triage badge.
//
// Render flow per ThreadListIcon row:
//   1. Resolve thread → array of RFC-822 Message-IDs (cached).
//   2. Fetch ThreadState from sidecar /thread (cached, 200ms timeout).
//   3. Pick layer:
//        Layer 1 (Person tier)      if rating >= 1 AND person-level source
//                                   → <PersonBand />
//        Layer 1.5 (LLM suggestion) else if suggested_rating >= 1
//                                   → <RatingSuggestionChip />  (Phase 6.0.f)
//        Layer 2 (Category tag)     else if cluster_id IN [1..28] excluding
//                                   fall-through {29,30,31,38}
//                                   → <CategoryTag />
//        Layer 3 (Content)          else if tldr_text non-null
//                                   → <ContentMarker />
//        else → blank (returns null).
//
// Default for unknown / sidecar-down → blank. The badge silent-fails
// rather than rendering an error indicator.
const FALL_THROUGH_CLUSTER_IDS = new Set([29, 30, 31, 38]);
// Minimum rating that earns a visible PersonBand. Manual ratings of 1 are
// rare; this floor avoids cluttering the slot with low-tier digits the owner
// didn't intentionally type. Lower if you want explicit 1s to surface.
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
    const { rating, rating_source, cluster_id, tldr_text, suggested_rating, } = state;
    if (typeof rating === 'number'
        && rating >= PERSON_BAND_MIN_RATING
        && PERSON_LEVEL_SOURCES.has(rating_source)) {
        return 'person';
    }
    // LLM rating suggestion: shown when no person-level rating exists.
    // suggested_rating === 0 is "no signal" and falls through — same logic
    // as ratings.effective_rating_decision returning ZERO source.
    if (typeof suggested_rating === 'number' && suggested_rating >= 1) {
        return 'rating_suggestion';
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
        this._unsubRefresh = sidecarClient.onThreadCacheRefresh(() => this._refresh());
    }
    componentWillUnmount() {
        this._mounted = false;
        if (this._unsubRefresh)
            this._unsubRefresh();
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
        if (layer === 'rating_suggestion') {
            return (mailspring_exports_1.React.createElement(rating_suggestion_chip_1.default, { rating: threadState.suggested_rating, confidence: threadState.suggestion_confidence, reason: threadState.suggestion_reason, clusterName: threadState.cluster_name }));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5nYWdlbWVudC1iYWRnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9lbmdhZ2VtZW50LWJhZGdlLmpzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDJEQUFzRDtBQUN0RCxnRUFBdUM7QUFDdkMsc0ZBQTREO0FBQzVELGtFQUF5QztBQUN6QyxzRUFBNkM7QUFFN0MsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFFbEQsdUJBQXVCO0FBQ3ZCLEVBQUU7QUFDRiw2Q0FBNkM7QUFDN0MsRUFBRTtBQUNGLHNDQUFzQztBQUN0QywrREFBK0Q7QUFDL0QsdUVBQXVFO0FBQ3ZFLG1CQUFtQjtBQUNuQiwyRUFBMkU7QUFDM0UscURBQXFEO0FBQ3JELGtFQUFrRTtBQUNsRSw4RUFBOEU7QUFDOUUsNEVBQTRFO0FBQzVFLCtEQUErRDtBQUMvRCxzREFBc0Q7QUFDdEQsK0RBQStEO0FBQy9ELHdEQUF3RDtBQUN4RCxzQ0FBc0M7QUFDdEMsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSw0Q0FBNEM7QUFFNUMsTUFBTSx3QkFBd0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFFM0QsMEVBQTBFO0FBQzFFLHdFQUF3RTtBQUN4RSx1RUFBdUU7QUFDdkUsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLENBQUM7QUFFakMsd0VBQXdFO0FBQ3hFLG1FQUFtRTtBQUNuRSx1RUFBdUU7QUFDdkUsNkJBQTZCO0FBQzdCLE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDbkMsUUFBUTtJQUNSLEtBQUs7SUFDTCxpQkFBaUI7SUFDakIsUUFBUTtDQUNULENBQUMsQ0FBQztBQUVILFNBQVMsU0FBUyxDQUFDLEtBQUs7SUFDdEIsSUFBSSxDQUFDLEtBQUs7UUFBRSxPQUFPLE9BQU8sQ0FBQztJQUUzQixNQUFNLEVBQ0os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