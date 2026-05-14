"""Unit tests for Phase 5 event_drafter — POST /draft-event backing logic.

Mocks claude_cli.call so tests don't touch the real Claude CLI. Validates:
  - RFC-ID → PK resolution and the unknown-RFC error path.
  - me_addresses filtering from suggested attendees.
  - Body trimming at BODY_MAX_CHARS.
  - Sanitization of attendee list (lowercase, dedupe, drop bad emails).
  - LLM failure falls back to subject-as-title + sensible defaults.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from mml_classifier import claude_cli, config, event_drafter


SCHEMA_SQL = """
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    sender_addr TEXT,
    sender_name TEXT,
    subject TEXT,
    body_plain TEXT,
    body_html TEXT,
    sent_date TEXT,
    received_date TEXT,
    tombstone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    kind TEXT NOT NULL,
    name TEXT,
    addr TEXT,
    tombstone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE me_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE CHECK (email = LOWER(email))
);
"""


@pytest.fixture
def temp_warehouse(tmp_path: Path) -> Path:
    db_path = tmp_path / "warehouse.sqlite"
    con = sqlite3.connect(db_path)
    try:
        con.executescript(SCHEMA_SQL)
        con.execute(
            "INSERT INTO messages (id, message_id, sender_addr, sender_name, "
            "subject, body_plain, received_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                1, "<abc@example>", "jane@example.com", "Jane Doe",
                "Project sync next week",
                "Hi the owner — let's meet Tuesday at 2pm to review the deck.",
                "2026-05-09T10:00:00",
            ),
        )
        con.execute(
            "INSERT INTO recipients (message_id, kind, name, addr) "
            "VALUES (?, ?, ?, ?)",
            (1, "to", "the inbox owner", "you@example.com"),
        )
        con.execute(
            "INSERT INTO recipients (message_id, kind, name, addr) "
            "VALUES (?, ?, ?, ?)",
            (1, "cc", "Bob Smith", "bob@example.com"),
        )
        con.execute(
            "INSERT INTO me_addresses (email) VALUES (?)",
            ("you@example.com",),
        )
        con.commit()
    finally:
        con.close()
    return db_path


@pytest.fixture(autouse=True)
def _redirect_paths(monkeypatch, temp_warehouse):
    monkeypatch.setattr(config, "WAREHOUSE_DB", temp_warehouse)
    yield


# ---- Mock Claude responses -------------------------------------------------


def _stub_claude(monkeypatch, response: dict) -> list[dict]:
    """Replace claude_cli.call with a stub. Returns a list capturing call args."""
    captured: list[dict] = []

    def _fake_call(prompt, *, system, json_schema=None, **kwargs):
        captured.append({
            "prompt": prompt,
            "system": system,
            "json_schema": json_schema,
        })
        return response

    monkeypatch.setattr(event_drafter.claude_cli, "call", _fake_call)
    return captured


def _stub_claude_raises(monkeypatch, exc: Exception) -> None:
    def _fake_call(prompt, *, system, json_schema=None, **kwargs):
        raise exc

    monkeypatch.setattr(event_drafter.claude_cli, "call", _fake_call)


# ---- Tests -----------------------------------------------------------------


def test_draft_event_via_rfc_message_id(monkeypatch):
    captured = _stub_claude(monkeypatch, {
        "title": "Project sync with Jane",
        "description": "Review the deck Jane sent Tuesday.",
        "proposed_start_iso": "2026-05-12T14:00:00-07:00",
        "duration_minutes": 30,
        "attendees": [
            {"email": "jane@example.com", "name": "Jane Doe"},
            {"email": "bob@example.com", "name": "Bob Smith"},
        ],
        "confidence": "high",
    })

    result = event_drafter.draft_event(rfc_message_id="<abc@example>")

    assert result.error is None
    assert result.source_message_id == 1
    assert result.title == "Project sync with Jane"
    assert result.proposed_start_iso == "2026-05-12T14:00:00-07:00"
    assert result.duration_minutes == 30
    assert result.confidence == "high"
    assert {a.email for a in result.attendees} == {"jane@example.com", "bob@example.com"}

    # Body got included in the user prompt
    assert len(captured) == 1
    assert "Project sync next week" in captured[0]["prompt"]
    assert "Tuesday at 2pm" in captured[0]["prompt"]


def test_draft_event_filters_me_addresses_from_attendees(monkeypatch):
    """Even if Claude returns the owner's address in attendees, it should be stripped."""
    _stub_claude(monkeypatch, {
        "title": "Sync",
        "description": "desc",
        "proposed_start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "attendees": [
            {"email": "you@example.com", "name": "the owner"},  # should drop
            {"email": "jane@example.com"},
        ],
        "confidence": "low",
    })

    result = event_drafter.draft_event(message_id=1)
    assert result.error is None
    emails = {a.email for a in result.attendees}
    assert "you@example.com" not in emails
    assert "jane@example.com" in emails


def test_draft_event_dedupes_attendees(monkeypatch):
    _stub_claude(monkeypatch, {
        "title": "Sync",
        "description": "desc",
        "proposed_start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "attendees": [
            {"email": "Jane@Example.com"},
            {"email": "jane@example.com", "name": "Jane"},
            {"email": "JANE@EXAMPLE.COM"},
        ],
        "confidence": "low",
    })
    result = event_drafter.draft_event(message_id=1)
    assert [a.email for a in result.attendees] == ["jane@example.com"]


def test_draft_event_drops_malformed_attendee_entries(monkeypatch):
    _stub_claude(monkeypatch, {
        "title": "Sync",
        "description": "desc",
        "proposed_start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "attendees": [
            {"email": ""},
            {"email": "not-an-email"},
            "string-not-dict",
            {"email": "valid@example.com"},
        ],
        "confidence": "low",
    })
    result = event_drafter.draft_event(message_id=1)
    assert [a.email for a in result.attendees] == ["valid@example.com"]


def test_draft_event_unknown_rfc_returns_error_with_fallback(monkeypatch):
    _stub_claude(monkeypatch, {
        "title": "should not be called",
        "description": "x",
        "proposed_start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30,
        "attendees": [],
        "confidence": "low",
    })
    result = event_drafter.draft_event(rfc_message_id="<does-not-exist@example>")
    assert result.source_message_id is None
    assert result.title is None
    assert "unknown rfc_message_id" in (result.error or "")
    # Fallback start_iso is populated so the overlay can still render.
    assert result.proposed_start_iso is not None
    assert result.duration_minutes == 30


def test_draft_event_no_input_returns_error():
    result = event_drafter.draft_event()
    assert result.error is not None
    assert "must supply" in result.error
    assert result.source_message_id is None


def test_draft_event_llm_failure_falls_back_to_subject(monkeypatch):
    _stub_claude_raises(monkeypatch, claude_cli.ClaudeCallError("claude timed out"))

    result = event_drafter.draft_event(message_id=1)
    assert result.source_message_id == 1
    assert result.title == "Project sync next week"  # from messages.subject
    assert result.description is None
    assert result.proposed_start_iso is not None
    assert result.duration_minutes == 30
    assert result.attendees == []
    assert result.error and "llm draft unavailable" in result.error


def test_draft_event_truncates_long_body(monkeypatch):
    huge = "X" * (config.BODY_MAX_CHARS + 5000)
    con = sqlite3.connect(config.WAREHOUSE_DB)
    try:
        con.execute("UPDATE messages SET body_plain = ? WHERE id = 1", (huge,))
        con.commit()
    finally:
        con.close()

    captured = _stub_claude(monkeypatch, {
        "title": "T", "description": "D",
        "proposed_start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30, "attendees": [], "confidence": "low",
    })

    event_drafter.draft_event(message_id=1)
    assert len(captured) == 1
    user_prompt = captured[0]["prompt"]
    # Cut at BODY_MAX_CHARS, plus the truncation marker we add.
    assert "[...truncated]" in user_prompt
    # Should NOT contain the full huge body length.
    assert user_prompt.count("X") <= config.BODY_MAX_CHARS + 100


def test_draft_event_unknown_duration_falls_back_to_30(monkeypatch):
    _stub_claude(monkeypatch, {
        "title": "T", "description": "D",
        "proposed_start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 17,  # not in {15,30,45,60,90}
        "attendees": [], "confidence": "low",
    })
    result = event_drafter.draft_event(message_id=1)
    assert result.duration_minutes == 30


def test_draft_event_unknown_confidence_falls_back_to_low(monkeypatch):
    _stub_claude(monkeypatch, {
        "title": "T", "description": "D",
        "proposed_start_iso": "2026-05-12T10:00:00-07:00",
        "duration_minutes": 30, "attendees": [],
        "confidence": "maybe",
    })
    result = event_drafter.draft_event(message_id=1)
    assert result.confidence == "low"
