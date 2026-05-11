"""Google Calendar API event JSON → warehouse row dicts.

Pure data transformation, no I/O. The ingest CLI gets a Google API event
payload (one item from events.list) and asks this module for a
NormalizedEvent it can then INSERT/UPDATE alongside attendee rows.

Recurring events: ingest uses `singleEvents=true`, so Google returns
expanded occurrences. The `recurring_event_id` on each occurrence points
to the master series id — preserved as a column for grouping.

All-day events: Google's `start.date` (YYYY-MM-DD, no time) → all_day=1,
start_iso = the date string. Otherwise `start.dateTime` is an ISO 8601
string (Google always includes the offset).

Cancelled events: ingest's responsibility to translate to the 'cancel'
change_kind. Normalize just sets status='cancelled'.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class NormalizedAttendee:
    email: str
    display_name: str | None
    response_status: str | None
    is_organizer: int
    is_optional: int
    is_self: int
    is_resource: int


@dataclass(frozen=True)
class NormalizedEvent:
    gcal_event_id: str
    ical_uid: str | None
    recurring_event_id: str | None
    title: str | None
    description: str | None
    location: str | None
    start_iso: str | None
    end_iso: str | None
    timezone: str | None
    all_day: int
    status: str | None
    organizer_email: str | None
    organizer_self: int
    visibility: str | None
    transparency: str | None
    etag: str | None
    html_link: str | None
    hangout_link: str | None
    created_at_google: str | None
    updated_at_google: str | None
    attendees: list[NormalizedAttendee] = field(default_factory=list)


def _str_or_none(v: Any) -> str | None:
    if isinstance(v, str) and v.strip():
        return v
    return None


def _bool_to_int(v: Any) -> int:
    return 1 if bool(v) else 0


def _normalize_start_end(start: Any, end: Any) -> tuple[str | None, str | None, str | None, int]:
    """Return (start_iso, end_iso, timezone, all_day).

    Google's shape:
      timed:   {"dateTime": "2026-05-12T14:00:00-07:00", "timeZone": "America/Los_Angeles"}
      all-day: {"date": "2026-05-12"}                  (no timeZone field)
    """
    if not isinstance(start, dict):
        start = {}
    if not isinstance(end, dict):
        end = {}

    all_day = 1 if start.get("date") else 0
    if all_day:
        start_iso = _str_or_none(start.get("date"))
        end_iso = _str_or_none(end.get("date"))
        tz = _str_or_none(start.get("timeZone"))  # usually absent for all-day
    else:
        start_iso = _str_or_none(start.get("dateTime"))
        end_iso = _str_or_none(end.get("dateTime"))
        # timeZone field is per-side; we use start's. Falls back to end's if
        # start was missing (rare).
        tz = _str_or_none(start.get("timeZone")) or _str_or_none(end.get("timeZone"))
    return start_iso, end_iso, tz, all_day


def _normalize_attendees(raw: Any) -> list[NormalizedAttendee]:
    if not isinstance(raw, list):
        return []
    out: list[NormalizedAttendee] = []
    seen: set[str] = set()
    for a in raw:
        if not isinstance(a, dict):
            continue
        email = (a.get("email") or "").strip().lower()
        if not email or "@" not in email or email in seen:
            continue
        seen.add(email)
        out.append(NormalizedAttendee(
            email=email,
            display_name=_str_or_none(a.get("displayName")),
            response_status=_str_or_none(a.get("responseStatus")),
            is_organizer=_bool_to_int(a.get("organizer")),
            is_optional=_bool_to_int(a.get("optional")),
            is_self=_bool_to_int(a.get("self")),
            is_resource=_bool_to_int(a.get("resource")),
        ))
    return out


def normalize_event(event: dict[str, Any]) -> NormalizedEvent | None:
    """Translate one Google Calendar API event into a NormalizedEvent.

    Returns None for events with no `id` (Google sometimes returns sync
    sentinels we should skip). Cancelled events ARE returned (with
    status='cancelled') — the ingest layer decides what to do with them.
    """
    gcal_event_id = _str_or_none(event.get("id"))
    if not gcal_event_id:
        return None

    start_iso, end_iso, tz, all_day = _normalize_start_end(
        event.get("start"), event.get("end")
    )

    organizer = event.get("organizer") if isinstance(event.get("organizer"), dict) else {}
    organizer_email = (organizer.get("email") or "").strip().lower() or None
    organizer_self = _bool_to_int(organizer.get("self"))

    return NormalizedEvent(
        gcal_event_id=gcal_event_id,
        ical_uid=_str_or_none(event.get("iCalUID")),
        recurring_event_id=_str_or_none(event.get("recurringEventId")),
        title=_str_or_none(event.get("summary")),
        description=_str_or_none(event.get("description")),
        location=_str_or_none(event.get("location")),
        start_iso=start_iso,
        end_iso=end_iso,
        timezone=tz,
        all_day=all_day,
        status=_str_or_none(event.get("status")),
        organizer_email=organizer_email,
        organizer_self=organizer_self,
        visibility=_str_or_none(event.get("visibility")),
        transparency=_str_or_none(event.get("transparency")),
        etag=_str_or_none(event.get("etag")),
        html_link=_str_or_none(event.get("htmlLink")),
        hangout_link=_str_or_none(event.get("hangoutLink")),
        created_at_google=_str_or_none(event.get("created")),
        updated_at_google=_str_or_none(event.get("updated")),
        attendees=_normalize_attendees(event.get("attendees")),
    )
