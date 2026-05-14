"""End-to-end tests for calendar_intake.

Builds a temp warehouse with the unified calendar schema, feeds raw
Google event dicts directly into build_plan (no Google API mocking
needed), commits, and asserts the resulting rows. Covers:
  - First-time insert flow (events + attendees + event_changes 'insert')
  - Idempotent re-run with same etag → skip, no new event_changes
  - Field change → 'update' with diff_json populated
  - Status flip to cancelled → 'cancel'
  - Identity hookup: new attendee emails create contact_entities rows
  - sync_token persisted on commit
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from mml_classifier import calendar_intake, config


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT
);
CREATE TABLE me_addresses (
    email TEXT PRIMARY KEY CHECK (email = LOWER(email))
);
CREATE TABLE contact_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL,
    canonical_email TEXT,
    notes TEXT,
    is_mark INTEGER NOT NULL DEFAULT 0,
    is_list_addr INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT,
    ingester_version TEXT,
    tombstone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE contact_email_map (
    email TEXT PRIMARY KEY CHECK (email = LOWER(email)),
    contact_entity_id INTEGER NOT NULL REFERENCES contact_entities(id),
    primary_for_contact INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT,
    last_seen_at TEXT,
    tombstone INTEGER NOT NULL DEFAULT 0
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
    email TEXT NOT NULL CHECK (email = LOWER(email)),
    display_name TEXT,
    response_status TEXT,
    is_organizer INTEGER NOT NULL DEFAULT 0,
    is_optional INTEGER NOT NULL DEFAULT 0,
    is_self INTEGER NOT NULL DEFAULT 0,
    is_resource INTEGER NOT NULL DEFAULT 0,
    UNIQUE(event_id, email)
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
            "INSERT INTO calendars (id, google_account, gcal_calendar_id, "
            "display_name, timezone, is_default, is_primary) "
            "VALUES (1, 'mark@example.com', 'primary', 'the owner', "
            "'America/Los_Angeles', 1, 1)"
        )
        con.execute(
            "INSERT INTO me_addresses (email) VALUES ('mark@example.com')"
        )
        con.commit()
    finally:
        con.close()
    return db_path


@pytest.fixture(autouse=True)
def _redirect_paths(monkeypatch, temp_warehouse):
    monkeypatch.setattr(config, "WAREHOUSE_DB", temp_warehouse)
    yield


def _read_events(db_path: Path) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute("SELECT * FROM events ORDER BY id").fetchall())
    finally:
        con.close()


def _read_attendees(db_path: Path, event_id: int) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute(
            "SELECT * FROM event_attendees WHERE event_id = ? ORDER BY id",
            (event_id,),
        ).fetchall())
    finally:
        con.close()


def _read_changes(db_path: Path, event_id: int | None = None) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        if event_id is None:
            return list(con.execute(
                "SELECT * FROM event_changes ORDER BY id"
            ).fetchall())
        return list(con.execute(
            "SELECT * FROM event_changes WHERE event_id = ? ORDER BY id",
            (event_id,),
        ).fetchall())
    finally:
        con.close()


def _read_calendar(db_path: Path, cal_id: int) -> sqlite3.Row:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(
            "SELECT * FROM calendars WHERE id = ?", (cal_id,)
        ).fetchone()
    finally:
        con.close()


# ---- Sample Google events --------------------------------------------------


def _evt(**kwargs) -> dict:
    base = {
        "id": "evt-001",
        "iCalUID": "evt-001@google.com",
        "etag": '"v1"',
        "summary": "Project sync",
        "start": {"dateTime": "2026-05-12T14:00:00-07:00", "timeZone": "America/Los_Angeles"},
        "end":   {"dateTime": "2026-05-12T14:30:00-07:00", "timeZone": "America/Los_Angeles"},
        "status": "confirmed",
        "organizer": {"email": "mark@example.com", "self": True},
        "attendees": [
            {"email": "jane@example.com", "displayName": "Jane Doe",
             "responseStatus": "accepted"},
        ],
    }
    base.update(kwargs)
    return base


# ---- Tests -----------------------------------------------------------------


def test_first_time_insert_creates_event_attendees_and_change_row(temp_warehouse):
    plan = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([_evt()]),
        meta={"next_sync_token": "token-A"},
        full_backfill=True,
    )
    assert len(plan.actions) == 1
    assert plan.actions[0].kind == "insert"

    stats = calendar_intake.commit_plan(plan)
    assert stats.events_inserted == 1
    assert stats.changes_inserted == 1
    assert stats.attendees_inserted == 1
    # mark@ (organizer, in me_addresses but not yet in contact_entities)
    # and jane@ (attendee) both get auto-created.
    assert stats.contacts_inserted == 2

    rows = _read_events(temp_warehouse)
    assert len(rows) == 1
    r = rows[0]
    assert r["gcal_event_id"] == "evt-001"
    assert r["source"] == "gcal-sync"
    assert r["title"] == "Project sync"
    assert r["etag"] == '"v1"'
    assert r["organizer_email"] == "mark@example.com"
    assert r["organizer_self"] == 1

    atts = _read_attendees(temp_warehouse, r["id"])
    assert len(atts) == 1
    assert atts[0]["email"] == "jane@example.com"
    assert atts[0]["response_status"] == "accepted"

    chs = _read_changes(temp_warehouse, r["id"])
    assert len(chs) == 1
    assert chs[0]["change_kind"] == "insert"
    assert chs[0]["etag_after"] == '"v1"'
    assert chs[0]["etag_before"] is None
    snap = json.loads(chs[0]["snapshot_json"])
    assert snap["id"] == "evt-001"

    # sync_token persisted
    cal = _read_calendar(temp_warehouse, 1)
    assert cal["sync_token"] == "token-A"
    assert cal["synced_at"] is not None


def test_re_run_same_etag_skips_no_history_row(temp_warehouse):
    # First run
    plan_1 = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([_evt()]),
        meta={"next_sync_token": "token-A"}, full_backfill=True,
    )
    calendar_intake.commit_plan(plan_1)

    # Second run with same payload
    plan_2 = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([_evt()]),
        meta={"next_sync_token": "token-B"}, full_backfill=False,
    )
    assert all(a.kind == "skip" for a in plan_2.actions)
    stats_2 = calendar_intake.commit_plan(plan_2)
    assert stats_2.events_inserted == 0
    assert stats_2.events_updated == 0
    assert stats_2.changes_inserted == 0
    assert stats_2.events_skipped == 1

    # Still only one history row total
    chs = _read_changes(temp_warehouse)
    assert len(chs) == 1
    # sync_token rolled forward despite no real changes
    cal = _read_calendar(temp_warehouse, 1)
    assert cal["sync_token"] == "token-B"


def test_field_change_creates_update_with_diff(temp_warehouse):
    calendar_intake.commit_plan(
        calendar_intake.build_plan(
            calendar_pk=1, gcal_calendar_id="primary",
            events_iter=iter([_evt()]),
            meta={"next_sync_token": "token-A"}, full_backfill=True,
        )
    )

    # Reschedule + retitle
    moved = _evt(
        etag='"v2"',
        summary="Project sync (rescheduled)",
        start={"dateTime": "2026-05-13T14:00:00-07:00", "timeZone": "America/Los_Angeles"},
        end={"dateTime": "2026-05-13T14:30:00-07:00", "timeZone": "America/Los_Angeles"},
    )
    plan = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([moved]),
        meta={"next_sync_token": "token-B"}, full_backfill=False,
    )
    assert plan.actions[0].kind == "update"
    stats = calendar_intake.commit_plan(plan)
    assert stats.events_updated == 1
    assert stats.changes_inserted == 1

    rows = _read_events(temp_warehouse)
    assert rows[0]["title"] == "Project sync (rescheduled)"
    assert rows[0]["start_iso"] == "2026-05-13T14:00:00-07:00"
    assert rows[0]["etag"] == '"v2"'

    chs = _read_changes(temp_warehouse, rows[0]["id"])
    assert len(chs) == 2
    assert chs[-1]["change_kind"] == "update"
    assert chs[-1]["etag_before"] == '"v1"'
    assert chs[-1]["etag_after"] == '"v2"'
    diff = json.loads(chs[-1]["diff_json"])
    assert "field_changes" in diff
    assert "title" in diff["field_changes"]
    assert "start_iso" in diff["field_changes"]


def test_status_cancelled_yields_cancel_change_kind(temp_warehouse):
    calendar_intake.commit_plan(
        calendar_intake.build_plan(
            calendar_pk=1, gcal_calendar_id="primary",
            events_iter=iter([_evt()]),
            meta={"next_sync_token": "token-A"}, full_backfill=True,
        )
    )

    cancelled = _evt(etag='"v2"', status="cancelled")
    plan = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([cancelled]),
        meta={"next_sync_token": "token-B"}, full_backfill=False,
    )
    assert plan.actions[0].kind == "cancel"
    stats = calendar_intake.commit_plan(plan)
    assert stats.events_cancelled == 1
    rows = _read_events(temp_warehouse)
    assert rows[0]["status"] == "cancelled"


def test_attendee_changes_replace_rows_and_recorded_in_diff(temp_warehouse):
    calendar_intake.commit_plan(
        calendar_intake.build_plan(
            calendar_pk=1, gcal_calendar_id="primary",
            events_iter=iter([_evt()]),
            meta={"next_sync_token": "token-A"}, full_backfill=True,
        )
    )

    # Add bob, drop jane, change … nothing in field state. Force a new etag.
    new_attendees = _evt(
        etag='"v2"',
        attendees=[
            {"email": "bob@example.com", "displayName": "Bob",
             "responseStatus": "needsAction"},
        ],
    )
    plan = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([new_attendees]),
        meta={"next_sync_token": "token-B"}, full_backfill=False,
    )
    assert plan.actions[0].kind == "update"
    stats = calendar_intake.commit_plan(plan)
    assert stats.events_updated == 1
    assert stats.attendees_deleted == 1   # jane wiped
    assert stats.attendees_inserted == 1  # bob added
    assert stats.contacts_inserted == 1   # bob is new

    rows = _read_events(temp_warehouse)
    atts = _read_attendees(temp_warehouse, rows[0]["id"])
    assert [a["email"] for a in atts] == ["bob@example.com"]

    chs = _read_changes(temp_warehouse, rows[0]["id"])
    diff = json.loads(chs[-1]["diff_json"])
    assert diff["attendees"]["added"] == ["bob@example.com"]
    assert diff["attendees"]["removed"] == ["jane@example.com"]


def test_organizer_email_creates_contact_when_not_in_attendees(temp_warehouse):
    """Some events have an organizer not in the attendees list (e.g. you organize, no one else is invited)."""
    solo = _evt(attendees=[])  # no attendees
    plan = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([solo]),
        meta={"next_sync_token": "token-A"}, full_backfill=True,
    )
    stats = calendar_intake.commit_plan(plan)
    # mark@example.com is the organizer; should be auto-created in contacts.
    assert stats.contacts_inserted == 1

    con = sqlite3.connect(temp_warehouse)
    try:
        rows = list(con.execute(
            "SELECT canonical_email FROM contact_entities ORDER BY id"
        ).fetchall())
    finally:
        con.close()
    assert any(r[0] == "mark@example.com" for r in rows)


def test_mark_address_attendee_sets_is_self_flag(temp_warehouse):
    """If an attendee email is in me_addresses, is_self flips to 1 even if Google didn't tell us."""
    raw = _evt(attendees=[
        # Google didn't include 'self: true' on this entry, but me_addresses has it.
        {"email": "mark@example.com", "responseStatus": "accepted"},
        {"email": "jane@example.com", "responseStatus": "needsAction"},
    ])
    plan = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([raw]),
        meta={"next_sync_token": "token-A"}, full_backfill=True,
    )
    calendar_intake.commit_plan(plan)
    rows = _read_events(temp_warehouse)
    atts = {a["email"]: a for a in _read_attendees(temp_warehouse, rows[0]["id"])}
    assert atts["mark@example.com"]["is_self"] == 1
    assert atts["jane@example.com"]["is_self"] == 0


def test_no_id_event_is_skipped_silently(temp_warehouse):
    """Sentinels without id should be filtered by normalize_event."""
    plan = calendar_intake.build_plan(
        calendar_pk=1, gcal_calendar_id="primary",
        events_iter=iter([{"status": "cancelled"}]),  # no id
        meta={"next_sync_token": "token-A"}, full_backfill=True,
    )
    assert plan.actions == []
    stats = calendar_intake.commit_plan(plan)
    assert stats.events_inserted == 0
    assert _read_events(temp_warehouse) == []
