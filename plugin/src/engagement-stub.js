// engagement-stub.js
// Phase 1 spike: deterministic per-thread "engagement" number stand-in.
// In Phase 3 this is replaced by a lookup against warehouse.sqlite via the
// Python sidecar. For the spike, we hash a stable per-thread key to a 0-999
// integer so values are stable across re-renders within a session and
// visually convincing as a sort key.

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
  if (!thread) return 'null';

  // Robust key: concatenate every stable identifier we can find on the
  // Mailspring Thread object. This guarantees variation per row even when
  // some fields aren't populated (e.g. participants is empty during the
  // initial render pass — Mailspring sometimes lazy-loads them).
  const parts = [];

  // 1. Thread server id — should be unique per thread.
  if (thread.id) parts.push(`id:${thread.id}`);

  // 2. Subject — varies row-to-row.
  if (thread.subject) parts.push(`s:${thread.subject}`);

  // 3. First participant email if we can get one.
  let participants = thread.participants;
  if (typeof participants === 'function') {
    try { participants = participants.call(thread); } catch (e) { participants = null; }
  }
  if (Array.isArray(participants) && participants.length > 0) {
    const first = participants.find(p => p && p.email);
    if (first) parts.push(`e:${first.email.toLowerCase()}`);
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

export function engagementForThread(thread) {
  if (!thread) return 0;
  return fnv1a32(buildKey(thread)) % 1000;
}

export function engagementForEmail(email) {
  if (!email) return 0;
  return fnv1a32(email.toLowerCase()) % 1000;
}
