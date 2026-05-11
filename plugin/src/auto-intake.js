// auto-intake.js
//
// Phase 5.5.3 — keep `warehouse.sqlite` current with Mailspring's inbox
// by triggering the sidecar's `/intake-now` endpoint shortly after mailsync
// persists new messages.
//
// Signal source: DatabaseStore.listen fires a DatabaseChangeRecord for
// every persist/unpersist event coming out of mailsync (mailsync-bridge.js
// line ~145). We filter for objectClass='Message' + type='persist' and
// schedule an intake after a quiet period.
//
// Debounce: 5-second trailing window. A burst of message persists during
// sync coalesces into a single /intake-now call after the burst quiets.
// The first persist in a session also schedules a call ~5s later.
//
// Resilience: 60-second hard ceiling — if persists keep arriving and
// debounce keeps resetting, fire anyway to avoid starvation. Backed off by
// re-scheduling at the next persist.

const sidecarClient = require('./sidecar-client');
const { DatabaseStore } = require('mailspring-exports');

const DEBOUNCE_MS = 5 * 1000;
const MAX_DEFER_MS = 60 * 1000;

let _unsubscribe = null;
let _debounceTimer = null;
let _firstScheduledAt = 0;
let _intakeInFlight = false;
let _disposed = false;

async function _runIntake() {
  if (_disposed) return;
  if (_intakeInFlight) return;
  _intakeInFlight = true;
  try {
    const res = await sidecarClient.intakeNow();
    if (!res) {
      // sidecar unreachable — silent. sidecar-client logs once per session.
      return;
    }
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn('[mml-productivity] /intake-now error:', res.error);
      return;
    }
    if (res.busy) {
      // Another intake is running. Re-arm a debounce so we try again soon.
      _scheduleIntake();
      return;
    }
    if ((res.messages_inserted || 0) > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[mml-productivity] auto-intake: +${res.messages_inserted} msgs, ` +
        `+${res.recipients_inserted || 0} recipients, ` +
        `+${res.contacts_inserted || 0} contacts, ` +
        `+${res.folders_inserted || 0} folders`
      );
    }
  } finally {
    _intakeInFlight = false;
  }
}

function _scheduleIntake() {
  if (_disposed) return;
  const now = Date.now();
  if (_firstScheduledAt === 0) _firstScheduledAt = now;
  const sinceFirst = now - _firstScheduledAt;

  if (_debounceTimer) clearTimeout(_debounceTimer);

  // If we've been deferring this batch for over a minute, fire now.
  if (sinceFirst >= MAX_DEFER_MS) {
    _debounceTimer = null;
    _firstScheduledAt = 0;
    _runIntake();
    return;
  }

  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    _firstScheduledAt = 0;
    _runIntake();
  }, DEBOUNCE_MS);
}

function _onChange(change) {
  if (!change || _disposed) return;
  // DatabaseChangeRecord fields: { type, objectClass, objects, objectsRawJSON }
  if (change.type !== 'persist') return;
  if (change.objectClass !== 'Message') return;
  const arr = change.objects || change.objectsRawJSON || [];
  if (!arr || arr.length === 0) return;
  _scheduleIntake();
}

export function activate() {
  if (_unsubscribe) return;
  _disposed = false;
  try {
    _unsubscribe = DatabaseStore.listen(_onChange, {});
    // eslint-disable-next-line no-console
    console.info('[mml-productivity] auto-intake: listening for Message persists ' +
                 `(debounce=${DEBOUNCE_MS / 1000}s).`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mml-productivity] auto-intake activate failed:', err);
  }
}

export function deactivate() {
  _disposed = true;
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_unsubscribe) {
    try { _unsubscribe(); } catch (_e) { /* noop */ }
    _unsubscribe = null;
  }
  _firstScheduledAt = 0;
}
