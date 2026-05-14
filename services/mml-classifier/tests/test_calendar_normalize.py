"""Unit tests for calendar_normalize — pure Google JSON → NormalizedEvent.

No I/O, no DB, no mocking. Just dict-in → dataclass-out.
"""

from __future__ import annotations

from mml_classifier.calendar_normalize import normalize_event


def test_normalize_timed_event_with_attendees():
    raw = {
        "id": "abc123",
        "iCalUID": "abc123@google.com",
        "etag": '"1234"',
        "summary": "Project sync",
        "description": "Review the deck",
        "location": "Zoom",
        "start": {"dateTime": "2026-05-12T14:00:00-07:00", "timeZone": "America/Los_Angeles"},
        "end":   {"dateTime": "2026-05-12T14:30:00-07:00", "timeZone": "America/Los_Angeles"},
        "status": "confirmed",
        "htmlLink": "https://calendar.google.com/event?eid=xyz",
        "hangoutLink": "https://meet.google.com/abc-defg-hij",
        "organizer": {"email": "mark@example.com", "self": True},
        "attendees": [
            {"email": "jane@example.com", "displayName": "Jane",
             "responseStatus": "accepted"},
            {"email": "bob@example.com", "responseStatus": "needsAction",
             "optional": True},
        ],
        "created": "2026-05-10T18:00:00.000Z",
        "updated": "2026-05-10T18:05:00.000Z",
        "transparency": "opaque",
        "visibility": "default",
    }
    n = normalize_event(raw)
    assert n is not None
    assert n.gcal_event_id == "abc123"
    assert n.ical_uid == "abc123@google.com"
    assert n.title == "Project sync"
    assert n.description == "Review the deck"
    assert n.location == "Zoom"
    assert n.start_iso == "2026-05-12T14:00:00-07:00"
    assert n.end_iso   == "2026-05-12T14:30:00-07:00"
    assert n.timezone  == "America/Los_Angeles"
    assert n.all_day == 0
    assert n.status == "confirmed"
    assert n.organizer_email == "mark@example.com"
    assert n.organizer_self == 1
    assert n.etag == '"1234"'
    assert n.html_link == "https://calendar.google.com/event?eid=xyz"
    assert n.hangout_link == "https://meet.google.com/abc-defg-hij"
    assert n.transparency == "opaque"
    assert n.visibility == "default"
    assert n.created_at_google == "2026-05-10T18:00:00.000Z"
    assert n.updated_at_google == "2026-05-10T18:05:00.000Z"

    emails = [a.email for a in n.attendees]
    assert emails == ["jane@example.com", "bob@example.com"]
    assert n.attendees[0].response_status == "accepted"
    assert n.attendees[1].is_optional == 1


def test_normalize_all_day_event():
    raw = {
        "id": "all-day-evt",
        "summary": "Holiday",
        "start": {"date": "2026-12-25"},
        "end":   {"date": "2026-12-26"},
        "status": "confirmed",
    }
    n = normalize_event(raw)
    assert n is not None
    assert n.all_day == 1
    assert n.start_iso == "2026-12-25"
    assert n.end_iso == "2026-12-26"
    assert n.timezone is None


def test_normalize_recurring_instance():
    raw = {
        "id": "master-id_20260512T140000",
        "recurringEventId": "master-id",
        "summary": "Weekly sync",
        "start": {"dateTime": "2026-05-12T14:00:00-07:00", "timeZone": "America/Los_Angeles"},
        "end":   {"dateTime": "2026-05-12T14:30:00-07:00", "timeZone": "America/Los_Angeles"},
        "status": "confirmed",
    }
    n = normalize_event(raw)
    assert n is not None
    assert n.recurring_event_id == "master-id"


def test_normalize_cancelled_event():
    raw = {
        "id": "cancelled-evt",
        "status": "cancelled",
        # Cancelled events from sync feeds often lack most fields.
    }
    n = normalize_event(raw)
    assert n is not None
    assert n.status == "cancelled"
    assert n.title is None
    assert n.start_iso is None


def test_normalize_returns_none_for_no_id():
    """Some sync responses include sentinels we should skip."""
    raw = {"status": "cancelled"}  # no id
    assert normalize_event(raw) is None


def test_normalize_attendees_lowercased_and_deduped():
    raw = {
        "id": "evt",
        "start": {"dateTime": "2026-05-12T14:00:00-07:00"},
        "end":   {"dateTime": "2026-05-12T14:30:00-07:00"},
        "attendees": [
            {"email": "Jane@Example.com"},
            {"email": "JANE@example.com"},
            {"email": "jane@example.com"},
            {"email": "  "},                  # empty after strip
            {"email": "not-an-email"},        # no @
            {"name": "missing email"},
            "not-a-dict",
        ],
    }
    n = normalize_event(raw)
    assert n is not None
    assert [a.email for a in n.attendees] == ["jane@example.com"]


def test_normalize_resource_and_self_flags():
    raw = {
        "id": "evt",
        "start": {"dateTime": "2026-05-12T14:00:00-07:00"},
        "end":   {"dateTime": "2026-05-12T14:30:00-07:00"},
        "attendees": [
            {"email": "room@example.com", "resource": True, "displayName": "Conf Room A"},
            {"email": "mark@example.com", "self": True},
            {"email": "jane@example.com", "organizer": True},
        ],
    }
    n = normalize_event(raw)
    assert n is not None
    by_email = {a.email: a for a in n.attendees}
    assert by_email["room@example.com"].is_resource == 1
    assert by_email["mark@example.com"].is_self == 1
    assert by_email["jane@example.com"].is_organizer == 1


def test_normalize_event_with_no_organizer():
    raw = {
        "id": "evt",
        "summary": "Quick task",
        "start": {"dateTime": "2026-05-12T14:00:00-07:00"},
        "end":   {"dateTime": "2026-05-12T14:30:00-07:00"},
    }
    n = normalize_event(raw)
    assert n is not None
    assert n.organizer_email is None
    assert n.organizer_self == 0
    assert n.attendees == []
