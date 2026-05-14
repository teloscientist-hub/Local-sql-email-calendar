"""Unit tests for Phase 5 event_creator — POST /create-event backing logic.

Mocks gcal_client.insert_event so tests don't touch Google. Validates:
  - Required field validation (title, start_iso, duration_minutes).
  - Default-calendar lookup.
  - source_message_id linkage via rfc_message_id.
  - Warehouse row written with the right columns.
  - GCal API errors propagate cleanly to the result.error.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from mml_classifier import config, event_creator, gcal_client


SCHEMA_SQL = """
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    sender_addr TEXT,
    sender_name TEXT,
    subject TEXT,
    received_date TEXT
);
CREATE TABLE calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_account TEXT NOT NULL,
    gcal_calendar_id TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    timezone TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    sync_token TEXT,
    source TEXT NOT NULL DEFAULT 'google',
    created_at TEXT,
    synced_at TEXT,
    ingester_version TEXT,
    tombstone INTEGER NOT NULL DEFAULT 0,
    UNIQUE(google_account, gcal_calendar_id)
);
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_pk INTEGER NOT NULL REFERENCES calendars(id),
    gcal_event_id TEXT NOT NULL,
    ical_uid TEXT,
    recurring_event_id TEXT,
    title TEXT,
    description TEXT,
    location TEXT,
    start_iso TEXT,
    end_iso TEXT,
    timezone TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    organizer_email TEXT,
    organizer_self INTEGER NOT NULL DEFAULT 0,
    visibility TEXT,
    transparency TEXT,
    etag TEXT,
    html_link TEXT,
    hangout_link TEXT,
    created_at_google TEXT,
    updated_at_google TEXT,
    source_message_id INTEGER REFERENCES messages(id),
    source TEXT NOT NULL DEFAULT 'gcal-sync',
    llm_drafted INTEGER NOT NULL DEFAULT 0,
    plugin_version TEXT,
    sidecar_version TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    tombstone INTEGER NOT NULL DEFAULT 0,
    UNIQUE(calendar_pk, gcal_event_id)
);
CREATE TABLE event_attendees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    response_status TEXT,
    is_organizer INTEGER NOT NULL DEFAULT 0,
    is_optional INTEGER NOT NULL DEFAULT 0,
    is_self INTEGER NOT NULL DEFAULT 0,
    is_resource INTEGER NOT NULL DEFAULT 0,
    UNIQUE(event_id, email),
    CHECK(email = LOWER(email))
);
CREATE TABLE event_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    etag_before TEXT,
    etag_after TEXT,
    change_kind TEXT NOT NULL,
    diff_json TEXT,
    snapshot_json TEXT NOT NULL
);
"""


@pytest.fixture
def temp_warehouse(tmp_path: Path) -> Path:
    db_path = tmp_path / "warehouse.sqlite"
    con = sqlite3.connect(db_path)
    try:
        con.executescript(SCHEMA_SQL)
        con.execute(
            "INSERT INTO messages (id, message_id, sender_addr, subject, received_date) "
            "VALUES (1, '<abc@example>', 'jane@example.com', 'Sync', '2026-05-09T10:00:00')"
        )
        con.execute(
            "INSERT INTO calendars (id, google_account, gcal_calendar_id, "
            "display_name, timezone, is_default, is_primary) "
            "VALUES (1, 'mark@example.com', 'primary', 'Primary', "
            "'America/Los_Angeles', 1, 1)"
        )
        con.commit()
    finally:
        con.close()
    return db_path


@pytest.fixture(autouse=True)
def _redirect_paths(monkeypatch, temp_warehouse):
    monkeypatch.setattr(config, "WAREHOUSE_DB", temp_warehouse)
    yield


# ---- Mock GCal client ------------------------------------------------------


def _stub_gcal(monkeypatch, response: dict) -> list[tuple]:
    captured: list[tuple] = []

    def _fake_insert(calendar_id, body):
        captured.append((calendar_id, body))
        return response

    monkeypatch.setattr(event_creator.gcal_client, "insert_event", _fake_insert)
    return captured


def _stub_gcal_raises(monkeypatch, exc: Exception) -> None:
    def _fake_insert(calendar_id, body):
        raise exc

    monkeypatch.setattr(event_creator.gcal_client, "insert_event", _fake_insert)


def _read_event_rows(db_path: Path) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute(
            "SELECT * FROM events ORDER BY id"
        ).fetchall())
    finally:
        con.close()


def _read_attendee_rows(db_path: Path, event_id: int) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute(
            "SELECT * FROM event_attendees WHERE event_id = ? ORDER BY id",
            (event_id,),
        ).fetchall())
    finally:
        con.close()


def _read_change_rows(db_path: Path, event_id: int) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute(
            "SELECT * FROM event_changes WHERE event_id = ? ORDER BY id",
            (event_id,),
        ).fetchall())
    finally:
        con.close()


_GCAL_RESPONSE = {
    "id": "fake-event-id-001",
    "htmlLink": "https://calendar.google.com/event?eid=xyz",
    "summary": "Project sync",
    "etag": '"fake-etag-001"',
    "status": "confirmed",
    "iCalUID": "fake-ical-uid-001@google.com",
    "created": "2026-05-10T18:00:00.000Z",
    "updated": "2026-05-10T18:00:00.000Z",
    "organizer": {"email": "mark@example.com", "self": True},
    "attendees": [
        {"email": "jane@example.com", "displayName": "Jane Doe",
         "responseStatus": "needsAction"},
    ],
}


# ---- Tests -----------------------------------------------------------------


def test_create_event_writes_warehouse_row(monkeypatch, temp_warehouse):
    captured = _stub_gcal(monkeypatch, _GCAL_RESPONSE)

    result = event_creator.create_event({
        "title": "Project sync",
        "description": "Review the deck",
        "start_iso": "2026-05-12T14:00:00-07:00",
        "duration_minutes": 30,
        "attendees": [{"email": "jane@example.com", "name": "Jane Doe"}],
        "rfc_message_id": "<abc@example>",
        "plugin_version": "mml-productivity@0.2.0",
    })

    assert result.error is None
    assert result.gcal_event_id == "fake-event-id-001"
    assert result.html_link == "https://calendar.google.com/event?eid=xyz"
    assert result.calendar_event_id is not None
    assert result.end_iso.startswith("2026-05-12T14:30:00")

    # GCal body shape sanity-check.
    assert len(captured) == 1
    calendar_id, body = captured[0]
    assert calendar_id == "primary"
    assert body["summary"] == "Project sync"
    assert body["start"]["timeZone"] == "America/Los_Angeles"
    assert body["attendees"] == [{"email": "jane@example.com", "displayName": "Jane Doe"}]

    # Warehouse row.
    rows = _read_event_rows(temp_warehouse)
    assert len(rows) == 1
    r = rows[0]
    assert r["calendar_pk"] == 1
    assert r["source_message_id"] == 1
    assert r["gcal_event_id"] == "fake-event-id-001"
    assert r["title"] == "Project sync"
    assert r["description"] == "Review the deck"
    assert r["start_iso"] == "2026-05-12T14:00:00-07:00"
    assert r["timezone"] == "America/Los_Angeles"
    assert r["plugin_version"] == "mml-productivity@0.2.0"
    assert r["llm_drafted"] == 1
    assert r["source"] == "plugin-create"
    assert r["etag"] == '"fake-etag-001"'
    assert r["status"] == "confirmed"
    assert r["ical_uid"] == "fake-ical-uid-001@google.com"
    assert r["organizer_email"] == "mark@example.com"
    assert r["organizer_self"] == 1

    # Normalized attendees written.
    attendees = _read_attendee_rows(temp_warehouse, r["id"])
    assert len(attendees) == 1
    a = attendees[0]
    assert a["email"] == "jane@example.com"
    assert a["display_name"] == "Jane Doe"
    assert a["response_status"] == "needsAction"

    # One plugin-create history row.
    changes = _read_change_rows(temp_warehouse, r["id"])
    assert len(changes) == 1
    assert changes[0]["change_kind"] == "plugin-create"
    assert changes[0]["etag_after"] == '"fake-etag-001"'
    snapshot = json.loads(changes[0]["snapshot_json"])
    assert snapshot["id"] == "fake-event-id-001"


def test_create_event_unknown_rfc_still_writes_event_with_null_source(monkeypatch, temp_warehouse):
    """An unknown rfc_message_id is non-fatal — event is created, just unlinked."""
    _stub_gcal(monkeypatch, _GCAL_RESPONSE)

    result = event_creator.create_event({
        "title": "Standalone event",
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "rfc_message_id": "<does-not-exist@example>",
    })
    assert result.error is None
    rows = _read_event_rows(temp_warehouse)
    assert rows[0]["source_message_id"] is None


def test_create_event_no_default_calendar_returns_error(monkeypatch, temp_warehouse):
    """Clear is_default; expect a clean error pointing at the setup CLI."""
    con = sqlite3.connect(temp_warehouse)
    try:
        con.execute("UPDATE calendars SET is_default = 0")
        con.commit()
    finally:
        con.close()

    result = event_creator.create_event({
        "title": "T",
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
    })
    assert result.error is not None
    assert "no default calendar" in result.error
    assert "gcal_oauth_setup" in result.error
    # No warehouse row written.
    assert _read_event_rows(temp_warehouse) == []


def test_create_event_missing_title_returns_error():
    result = event_creator.create_event({
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
    })
    assert result.error is not None
    assert "title is required" in result.error


def test_create_event_missing_start_returns_error():
    result = event_creator.create_event({
        "title": "T", "duration_minutes": 30,
    })
    assert result.error is not None
    assert "start_iso is required" in result.error


def test_create_event_invalid_start_iso_returns_error():
    result = event_creator.create_event({
        "title": "T",
        "start_iso": "not-a-date",
        "duration_minutes": 30,
    })
    assert result.error is not None
    assert "invalid start_iso" in result.error


def test_create_event_invalid_duration_returns_error():
    result = event_creator.create_event({
        "title": "T",
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 0,
    })
    assert result.error is not None
    assert "duration_minutes" in result.error


def test_create_event_gcal_api_error_propagates(monkeypatch, temp_warehouse):
    _stub_gcal_raises(monkeypatch, gcal_client.GcalApiError("rate limited"))

    result = event_creator.create_event({
        "title": "T",
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
    })
    assert result.error == "rate limited"
    assert result.gcal_event_id is None
    # No warehouse row on API failure.
    assert _read_event_rows(temp_warehouse) == []


def test_create_event_strips_invalid_attendees(monkeypatch, temp_warehouse):
    captured = _stub_gcal(monkeypatch, _GCAL_RESPONSE)

    event_creator.create_event({
        "title": "T",
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "attendees": [
            {"email": "valid@example.com", "name": "Valid"},
            {"email": ""},
            {"email": "no-at-symbol"},
            "not-a-dict",
            {"name": "missing email"},
        ],
    })

    body = captured[0][1]
    assert body["attendees"] == [
        {"email": "valid@example.com", "displayName": "Valid"},
    ]


def test_create_event_llm_drafted_false_records_zero(monkeypatch, temp_warehouse):
    _stub_gcal(monkeypatch, _GCAL_RESPONSE)
    event_creator.create_event({
        "title": "T",
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "llm_drafted": False,
    })
    rows = _read_event_rows(temp_warehouse)
    assert rows[0]["llm_drafted"] == 0


def test_create_event_picks_specific_calendar_pk(monkeypatch, temp_warehouse):
    """If calendar_pk is passed, prefer it over the default."""
    con = sqlite3.connect(temp_warehouse)
    try:
        con.execute(
            "INSERT INTO calendars (id, google_account, gcal_calendar_id, "
            "timezone, is_default) VALUES (2, 'mark@example.com', "
            "'side@group.calendar.google.com', 'UTC', 0)"
        )
        con.commit()
    finally:
        con.close()

    captured = _stub_gcal(monkeypatch, _GCAL_RESPONSE)
    event_creator.create_event({
        "title": "T",
        "start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "calendar_pk": 2,
    })

    calendar_id, body = captured[0]
    assert calendar_id == "side@group.calendar.google.com"
    assert body["start"]["timeZone"] == "UTC"

    rows = _read_event_rows(temp_warehouse)
    assert rows[0]["calendar_pk"] == 2
