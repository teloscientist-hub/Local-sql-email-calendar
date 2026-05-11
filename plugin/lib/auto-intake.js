"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
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
    if (_disposed)
        return;
    if (_intakeInFlight)
        return;
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
            console.info(`[mml-productivity] auto-intake: +${res.messages_inserted} msgs, ` +
                `+${res.recipients_inserted || 0} recipients, ` +
                `+${res.contacts_inserted || 0} contacts, ` +
                `+${res.folders_inserted || 0} folders`);
        }
    }
    finally {
        _intakeInFlight = false;
    }
}
function _scheduleIntake() {
    if (_disposed)
        return;
    const now = Date.now();
    if (_firstScheduledAt === 0)
        _firstScheduledAt = now;
    const sinceFirst = now - _firstScheduledAt;
    if (_debounceTimer)
        clearTimeout(_debounceTimer);
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
    if (!change || _disposed)
        return;
    // DatabaseChangeRecord fields: { type, objectClass, objects, objectsRawJSON }
    if (change.type !== 'persist')
        return;
    if (change.objectClass !== 'Message')
        return;
    const arr = change.objects || change.objectsRawJSON || [];
    if (!arr || arr.length === 0)
        return;
    _scheduleIntake();
}
function activate() {
    if (_unsubscribe)
        return;
    _disposed = false;
    try {
        _unsubscribe = DatabaseStore.listen(_onChange, {});
        // eslint-disable-next-line no-console
        console.info('[mml-productivity] auto-intake: listening for Message persists ' +
            `(debounce=${DEBOUNCE_MS / 1000}s).`);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mml-productivity] auto-intake activate failed:', err);
    }
}
exports.activate = activate;
function deactivate() {
    _disposed = true;
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
    }
    if (_unsubscribe) {
        try {
            _unsubscribe();
        }
        catch (_e) { /* noop */ }
        _unsubscribe = null;
    }
    _firstScheduledAt = 0;
}
exports.deactivate = deactivate;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXV0by1pbnRha2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvYXV0by1pbnRha2UuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLGlCQUFpQjtBQUNqQixFQUFFO0FBQ0Ysd0VBQXdFO0FBQ3hFLDRFQUE0RTtBQUM1RSx5QkFBeUI7QUFDekIsRUFBRTtBQUNGLHVFQUF1RTtBQUN2RSwyRUFBMkU7QUFDM0UsdUVBQXVFO0FBQ3ZFLDJDQUEyQztBQUMzQyxFQUFFO0FBQ0YseUVBQXlFO0FBQ3pFLHdFQUF3RTtBQUN4RSxrRUFBa0U7QUFDbEUsRUFBRTtBQUNGLHFFQUFxRTtBQUNyRSwyRUFBMkU7QUFDM0UscUNBQXFDOztBQUVyQyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsa0JBQWtCLENBQUMsQ0FBQztBQUNsRCxNQUFNLEVBQUUsYUFBYSxFQUFFLEdBQUcsT0FBTyxDQUFDLG9CQUFvQixDQUFDLENBQUM7QUFFeEQsTUFBTSxXQUFXLEdBQUcsQ0FBQyxHQUFHLElBQUksQ0FBQztBQUM3QixNQUFNLFlBQVksR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDO0FBRS9CLElBQUksWUFBWSxHQUFHLElBQUksQ0FBQztBQUN4QixJQUFJLGNBQWMsR0FBRyxJQUFJLENBQUM7QUFDMUIsSUFBSSxpQkFBaUIsR0FBRyxDQUFDLENBQUM7QUFDMUIsSUFBSSxlQUFlLEdBQUcsS0FBSyxDQUFDO0FBQzVCLElBQUksU0FBUyxHQUFHLEtBQUssQ0FBQztBQUV0QixLQUFLLFVBQVUsVUFBVTtJQUN2QixJQUFJLFNBQVM7UUFBRSxPQUFPO0lBQ3RCLElBQUksZUFBZTtRQUFFLE9BQU87SUFDNUIsZUFBZSxHQUFHLElBQUksQ0FBQztJQUN2QixJQUFJO1FBQ0YsTUFBTSxHQUFHLEdBQUcsTUFBTSxhQUFhLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDNUMsSUFBSSxDQUFDLEdBQUcsRUFBRTtZQUNSLHNFQUFzRTtZQUN0RSxPQUFPO1NBQ1I7UUFDRCxJ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