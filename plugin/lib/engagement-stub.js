"use strict";
// engagement-stub.js
// Phase 1 spike: deterministic per-thread "engagement" number stand-in.
// In Phase 3 this is replaced by a lookup against warehouse.sqlite via the
// Python sidecar. For the spike, we hash a stable per-thread key to a 0-999
// integer so values are stable across re-renders within a session and
// visually convincing as a sort key.
Object.defineProperty(exports, "__esModule", { value: true });
function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}
let __debugLogged = 0;
function buildKey(thread) {
    if (!thread)
        return 'null';
    // Robust key: concatenate every stable identifier we can find on the
    // Mailspring Thread object. This guarantees variation per row even when
    // some fields aren't populated (e.g. participants is empty during the
    // initial render pass — Mailspring sometimes lazy-loads them).
    const parts = [];
    // 1. Thread server id — should be unique per thread.
    if (thread.id)
        parts.push(`id:${thread.id}`);
    // 2. Subject — varies row-to-row.
    if (thread.subject)
        parts.push(`s:${thread.subject}`);
    // 3. First participant email if we can get one.
    let participants = thread.participants;
    if (typeof participants === 'function') {
        try {
            participants = participants.call(thread);
        }
        catch (e) {
            participants = null;
        }
    }
    if (Array.isArray(participants) && participants.length > 0) {
        const first = participants.find(p => p && p.email);
        if (first)
            parts.push(`e:${first.email.toLowerCase()}`);
    }
    // 4. Last message timestamp — guarantees variation even on threads that
    //    share a subject.
    if (thread.lastMessageReceivedTimestamp) {
        parts.push(`t:${thread.lastMessageReceivedTimestamp}`);
    }
    // 5. As a final fallback so we never collapse to a constant: account id.
    if (parts.length === 0 && thread.accountId) {
        parts.push(`a:${thread.accountId}`);
    }
    // One-time diagnostic so we can see what shape Mailspring 1.21 hands us.
    // Fires for the first 3 calls per session, then quiets down.
    if (__debugLogged < 3) {
        __debugLogged += 1;
        // eslint-disable-next-line no-console
        console.info('[mml-engagement-spike] thread shape sample:', {
            id: thread.id,
            subject: thread.subject,
            hasParticipants: Array.isArray(participants),
            participantCount: Array.isArray(participants) ? participants.length : 0,
            firstParticipantEmail: Array.isArray(participants) && participants[0] && participants[0].email,
            accountId: thread.accountId,
            keyParts: parts,
        });
    }
    return parts.length > 0 ? parts.join('|') : 'fallback';
}
function engagementForThread(thread) {
    if (!thread)
        return 0;
    return fnv1a32(buildKey(thread)) % 1000;
}
exports.engagementForThread = engagementForThread;
function engagementForEmail(email) {
    if (!email)
        return 0;
    return fnv1a32(email.toLowerCase()) % 1000;
}
exports.engagementForEmail = engagementForEmail;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5nYWdlbWVudC1zdHViLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2VuZ2FnZW1lbnQtc3R1Yi5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEscUJBQXFCO0FBQ3JCLHdFQUF3RTtBQUN4RSwyRUFBMkU7QUFDM0UsNEVBQTRFO0FBQzVFLHNFQUFzRTtBQUN0RSxxQ0FBcUM7O0FBRXJDLFNBQVMsT0FBTyxDQUFDLEdBQUc7SUFDbEIsSUFBSSxDQUFDLEdBQUcsVUFBVSxDQUFDO0lBQ25CLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO1FBQ25DLENBQUMsSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3ZCLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7S0FDekU7SUFDRCxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDakIsQ0FBQztBQUVELElBQUksYUFBYSxHQUFHLENBQUMsQ0FBQztBQUV0QixTQUFTLFFBQVEsQ0FBQyxNQUFNO0lBQ3RCLElBQUksQ0FBQyxNQUFNO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFFM0IscUVBQXFFO0lBQ3JFLHdFQUF3RTtJQUN4RSxzRUFBc0U7SUFDdEUsK0RBQStEO0lBQy9ELE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQztJQUVqQixxREFBcUQ7SUFDckQsSUFBSSxNQUFNLENBQUMsRUFBRTtRQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxNQUFNLENBQUMs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