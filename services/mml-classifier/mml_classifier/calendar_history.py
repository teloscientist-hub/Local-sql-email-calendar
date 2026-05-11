"""Diff computation + event_changes row construction.

When ingest sees an etag change for an event it already has, this module
computes which fields actually differ between the stored row and the new
normalized event. The resulting diff_json is the small "what changed"
payload stored in event_changes alongside the full Google snapshot_json.

Attendee changes are summarized at a high level (added / removed /
response_status_changed counts) rather than diffed cell-by-cell — the
full attendee state is preserved in snapshot_json, so callers wanting
exact attendee history can reconstruct from there.
"""

from __future__ import annotations

from typing import Any

from .calendar_normalize import NormalizedEvent

# Event-level fields whose changes get recorded in diff_json.
# Kept narrow: only fields that meaningfully change meeting semantics.
_DIFFABLE_FIELDS: tuple[str, ...] = (
    "title",
    "description",
    "location",
    "start_iso",
    "end_iso",
    "timezone",
    "all_day",
    "status",
    "organizer_email",
    "organizer_self",
    "visibility",
    "transparency",
    "html_link",
    "hangout_link",
    "recurring_event_id",
)


def compute_event_diff(
    old_row: dict[str, Any] | None,
    new_event: NormalizedEvent,
    old_attendees: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Compute the diff between an existing events row and a new event.

    Returns a dict shaped like:
        {
          "field_changes": {field: {"before": x, "after": y}, ...},
          "attendees": {"added": [...], "removed": [...], "response_changed": [...]},
        }

    Returns {} (empty dict) when nothing has changed.
    Returns the full new state under "field_changes" when `old_row` is None
    (i.e., insert-time). Caller is responsible for choosing the change_kind.
    """
    field_changes: dict[str, dict[str, Any]] = {}

    if old_row is None:
        # No prior state — every field is "new". Caller will normally pass
        # diff_json=NULL on insert and put the full state in snapshot_json,
        # but we provide this branch for completeness.
        for f in _DIFFABLE_FIELDS:
            v = getattr(new_event, f, None)
            if v is not None:
                field_changes[f] = {"before": None, "after": v}
    else:
        for f in _DIFFABLE_FIELDS:
            before = old_row.get(f)
            after = getattr(new_event, f, None)
            if before != after:
                field_changes[f] = {"before": before, "after": after}

    attendee_diff = _diff_attendees(old_attendees or [], new_event.attendees)

    out: dict[str, Any] = {}
    if field_changes:
        out["field_changes"] = field_changes
    if attendee_diff:
        out["attendees"] = attendee_diff
    return out


def _diff_attendees(
    old: list[dict[str, Any]],
    new: list[Any],  # list[NormalizedAttendee]
) -> dict[str, Any]:
    old_by_email: dict[str, dict[str, Any]] = {
        (r.get("email") or "").lower(): r for r in old if r.get("email")
    }
    new_by_email: dict[str, Any] = {a.email: a for a in new}

    added: list[str] = sorted(set(new_by_email) - set(old_by_email))
    removed: list[str] = sorted(set(old_by_email) - set(new_by_email))
    response_changed: list[dict[str, Any]] = []
    for email in sorted(set(old_by_email) & set(new_by_email)):
        before = old_by_email[email].get("response_status")
        after = new_by_email[email].response_status
        if before != after:
            response_changed.append({
                "email": email, "before": before, "after": after,
            })

    if not (added or removed or response_changed):
        return {}
    out: dict[str, Any] = {}
    if added:
        out["added"] = added
    if removed:
        out["removed"] = removed
    if response_changed:
        out["response_changed"] = response_changed
    return out


def classify_change_kind(
    old_row: dict[str, Any] | None,
    new_event: NormalizedEvent,
) -> str:
    """Pick the appropriate change_kind for the event_changes row.

    Rules:
      - First observation (no old_row)      → 'insert'
      - Status flipped to 'cancelled'       → 'cancel'
      - Otherwise                           → 'update'
    'delete' is reserved for events Google reports as deleted via sync
    token (which ingest handles separately, not via this function).
    """
    if old_row is None:
        return "insert"
    if new_event.status == "cancelled" and old_row.get("status") != "cancelled":
        return "cancel"
    return "update"
