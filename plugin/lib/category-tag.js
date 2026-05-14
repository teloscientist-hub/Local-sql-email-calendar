"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mailspring_exports_1 = require("mailspring-exports");
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
// long-form (e.g. "Newsletters / lists"); we show the first two words
// or a short manual abbreviation. Everything else falls back to the
// first 4 chars of cluster_name for visual minimalism.
const SHORT_LABELS = {
    1: 'Friend',
    2: 'TMC',
    3: 'Fam',
    4: 'Life',
    5: 'Coach',
    6: 'Course',
    7: 'Intro',
    8: 'B2B',
    10: 'Mstro',
    13: 'ARI',
    15: 'Jewel',
    16: 'Intro',
    17: 'Pod',
    22: 'Vendor',
    25: 'Estate',
};
function pickLabel(clusterId, clusterName) {
    if (clusterId in SHORT_LABELS)
        return SHORT_LABELS[clusterId];
    if (typeof clusterName === 'string' && clusterName.length > 0) {
        // Strip "/ ..." suffix and take the first word, max 6 chars.
        const head = clusterName.split(/[/(]/)[0].trim();
        const word = head.split(/\s+/)[0] || head;
        return word.slice(0, 6);
    }
    return '·';
}
class CategoryTag extends mailspring_exports_1.React.Component {
    render() {
        const { clusterId, clusterName } = this.props;
        if (typeof clusterId !== 'number')
            return null;
        const label = pickLabel(clusterId, clusterName);
        return (mailspring_exports_1.React.createElement("span", { className: "mml-category-tag", title: `Cluster ${clusterId}${clusterName ? `: ${clusterName}` : ''}` }, label));
    }
}
exports.default = CategoryTag;
CategoryTag.displayName = 'CategoryTag';
CategoryTag.propTypes = {
    clusterId: mailspring_exports_1.PropTypes.number,
    clusterName: mailspring_exports_1.PropTypes.string,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2F0ZWdvcnktdGFnLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2NhdGVnb3J5LXRhZy5qc3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSwyREFBc0Q7QUFFdEQsbUJBQW1CO0FBQ25CLEVBQUU7QUFDRix3RUFBd0U7QUFDeEUsd0VBQXdFO0FBQ3hFLHFFQUFxRTtBQUNyRSxzRUFBc0U7QUFDdEUscUVBQXFFO0FBQ3JFLHFDQUFxQztBQUNyQyxFQUFFO0FBQ0Ysc0VBQXNFO0FBQ3RFLGdEQUFnRDtBQUVoRCxrRUFBa0U7QUFDbEUsc0VBQXNFO0FBQ3RFLG9FQUFvRTtBQUNwRSx1REFBdUQ7QUFDdkQsTUFBTSxZQUFZLEdBQUc7SUFDbkIsQ0FBQyxFQUFHLFFBQVE7SUFDWixDQUFDLEVBQUcsS0FBSztJQUNULENBQUMsRUFBRyxLQUFLO0lBQ1QsQ0FBQyxFQUFHLE1BQU07SUFDVixDQUFDLEVBQUcsT0FBTztJQUNYLENBQUMsRUFBRyxRQUFRO0lBQ1osQ0FBQyxFQUFHLE9BQU87SUFDWCxDQUFDLEVBQUcsS0FBSztJQUNULEVBQUUsRUFBRSxPQUFPO0lBQ1gsRUFBRSxFQUFFLEtBQUs7SUFDVCxFQUFFLEVBQUUsT0FBTztJQUNYLEVBQUUsRUFBRSxPQUFPO0lBQ1gsRUFBRSxFQUFFLEtBQUs7SUFDVCxFQUFFLEVBQUUsUUFBUTtJQUNaLEVBQUUsRUFBRSxRQUFRO0NBQ2IsQ0FBQztBQUVGLFNBQVMsU0FBUyxDQUFDLFNBQVMsRUFBRSxXQUFXO0lBQ3ZDLElBQUksU0FBUyxJQUFJLFlBQVk7UUFBRSxPQUFPLFlBQVksQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUM5RCxJQUFJLE9BQU8sV0FBVyxLQUFLLFFBQVEsSUFBSSxXQUFXLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtRQUM3RCw2REFBNkQ7UUFDN0QsTUFBTSxJQUFJLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNqRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQztRQUMxQyxPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0tBQ3pCO0lBQ0QsT0FBTyxHQUFHLENBQUM7QUFDYixDQUFDO0FBRUQsTUFBcUIsV0FBWSxTQUFRLDBCQUFLLENBQUMsU0FBUztJQVF0RCxNQUFNO1FBQ0osTUFBTSxFQUFFLFNBQVMsRUFBRSxXQUFXLEVBQUUsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDO1FBQzlDLElBQUksT0FBTyxTQUFTLEtBQUssUUFBUTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQy9DLE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxTQUFTLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDaEQsT0FBTyxDQUNMLG1EQUNFLFNBQVMsRUFBQyxrQkFBa0IsRUFDNUIsS0FBSyxFQUFFLFdBQVcsU0FBUyxHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsS0FBSyxXQUFXLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLElBRXBFLEtBQUssQ0FDRCxDQUNSLENBQUM7SUFDSixDQUFDOztBQXBCSCw4QkFxQkM7QUFwQlEsdUJBQVcsR0FBRyxhQUFhLENBQUM7QUFFNUIscUJBQVMsR0FBRztJQUNqQixTQUFTLEVBQUUsOEJBQVMsQ0FBQyxNQUFNO0lBQzNCLFdBQVcsRUFBRSw4QkFBUyxDQUFDLE1BQU07Q0FDOUIsQ0FBQyJ9