import { React, PropTypes } from 'mailspring-exports';
import PersonBand from './person-band';
import RatingSuggestionChip from './rating-suggestion-chip';
import CategoryTag from './category-tag';
import ContentMarker from './content-marker';

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
  'manual',           // Ctrl+Opt+0..9 keystroke (per-message)
  'csv',              // contacts_to_rate.csv hand-set
  'priority_friend',  // sender_classifications.priority_friend=1
  'family',           // cluster_id=3
]);

function pickLayer(state) {
  if (!state) return 'blank';

  const {
    rating, rating_source, cluster_id, tldr_text,
    suggested_rating,
  } = state;

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

export default class EngagementBadge extends React.Component {
  static displayName = 'EngagementBadge';

  static propTypes = {
    thread: PropTypes.object,
  };

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
    if (this._unsubRefresh) this._unsubRefresh();
  }

  componentDidUpdate(prevProps) {
    const prev = prevProps && prevProps.thread && prevProps.thread.id;
    const curr = this.props.thread && this.props.thread.id;
    if (prev !== curr) this._refresh();
  }

  _refresh() {
    const { thread } = this.props;
    if (!thread || !thread.id) return;
    this._lastThreadId = thread.id;
    this.setState({ loading: true });
    sidecarClient.getThreadForMailspringThread(thread)
      .then(state => {
        if (!this._mounted) return;
        if (this._lastThreadId !== thread.id) return; // raced — drop
        this.setState({ threadState: state, loading: false });
      })
      .catch(() => {
        if (!this._mounted) return;
        this.setState({ threadState: null, loading: false });
      });
  }

  render() {
    const { threadState } = this.state;
    const layer = pickLayer(threadState);
    if (layer === 'blank') return null;

    if (layer === 'person') {
      return <PersonBand rating={threadState.rating} />;
    }
    if (layer === 'rating_suggestion') {
      return (
        <RatingSuggestionChip
          rating={threadState.suggested_rating}
          confidence={threadState.suggestion_confidence}
          reason={threadState.suggestion_reason}
          clusterName={threadState.cluster_name}
        />
      );
    }
    if (layer === 'category') {
      return (
        <CategoryTag
          clusterId={threadState.cluster_id}
          clusterName={threadState.cluster_name}
        />
      );
    }
    if (layer === 'content') {
      return <ContentMarker importanceScore={threadState.importance_score} />;
    }
    return null;
  }
}
