"""Unit tests for Phase 3 notes module — POST /add-note backing logic.

Spins up the same SQLite shape as test_manual_rating.py and exercises
notes.add_note across the five cases the Phase 3 plan calls out.
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from mml_classifier import config, manual_rating, notes


# ---- Schema (mirrors test_manual_rating.py) --------------------------------

SCHEMA_SQL = """
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    sender_addr TEXT,
    sender_name TEXT,
    subject TEXT,
    received_date TEXT
);
CREATE TABLE message_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    rating INTEGER NOT NULL CHECK(rating >= 0 AND rating <= 9),
    note TEXT,
    rated_at TEXT NOT NULL,
    system_rating_at_time INTEGER,
    system_cluster_at_time INTEGER,
    source TEXT NOT NULL DEFAULT 'plugin-keystroke',
    plugin_version TEXT,
    sidecar_version TEXT
);
CREATE INDEX idx_message_ratings_message
    ON message_ratings(message_id, rated_at DESC);
"""


CSV_HEADER = (
    "rating,name,email,other_emails,sent_to_them,recv_from_them,"
    "first_year,last_year,years_active,score,notes\n"
)


@pytest.fixture
def temp_warehouse(tmp_path: Path) -> Path:
    db_path = tmp_path / "warehouse.sqlite"
    con = sqlite3.connect(db_path)
    try:
        con.executescript(SCHEMA_SQL)
        con.execute(
            "INSERT INTO messages (id, sender_addr, sender_name) VALUES (?, ?, ?)",
            (1, "someone@example.com", "Some One"),
        )
        con.commit()
    finally:
        con.close()
    return db_path


@pytest.fixture
def temp_contacts_csv(tmp_path: Path) -> Path:
    csv_path = tmp_path / "contacts_to_rate.csv"
    csv_path.write_text(CSV_HEADER, encoding="utf-8")
    return csv_path


@pytest.fixture(autouse=True)
def _redirect_paths(monkeypatch, temp_warehouse, temp_contacts_csv):
    monkeypatch.setattr(config, "WAREHOUSE_DB", temp_warehouse)
    monkeypatch.setattr(config, "CONTACTS_CSV", temp_contacts_csv)
    yield


# ---- Helpers ---------------------------------------------------------------


def _read_message_ratings(db_path: Path) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute(
            "SELECT * FROM message_ratings ORDER BY id"
        ).fetchall())
    finally:
        con.close()


def _record_tag(message_id: int, rating: int, note: str | None = None) -> int:
    """Use manual_rating.record_tag to seed a row; return its rating_id."""
    result = manual_rating.record_tag(
        message_id=message_id, rating=rating, note=note, snapshot=None,
    )
    assert result.rating_id is not None
    return result.rating_id


# ---- Tests -----------------------------------------------------------------


def test_add_note_updates_latest_row(temp_warehouse):
    rating_id = _record_tag(1, 5)
    result = notes.add_note(1, "promo blast")
    assert result.error is None
    assert result.rating_id == rating_id
    assert result.note == "promo blast"

    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 1
    assert rows[0]["note"] == "promo blast"
    assert rows[0]["rating"] == 5  # rating value untouched


def test_add_note_overwrites_prior_note(temp_warehouse):
    rating_id = _record_tag(1, 5, note="v1")
    result = notes.add_note(1, "v2")
    assert result.error is None
    assert result.rating_id == rating_id
    assert result.note == "v2"

    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 1  # no new row inserted
    assert rows[0]["note"] == "v2"


def test_add_note_clears_with_empty_string(temp_warehouse):
    _record_tag(1, 5, note="v1")
    result = notes.add_note(1, "")
    assert result.error is None
    assert result.note is None

    rows = _read_message_ratings(temp_warehouse)
    assert rows[0]["note"] is None


def test_add_note_clears_with_whitespace(temp_warehouse):
    _record_tag(1, 5, note="v1")
    result = notes.add_note(1, "   ")
    assert result.error is None
    assert result.note is None
    rows = _read_message_ratings(temp_warehouse)
    assert rows[0]["note"] is None


def test_add_note_with_no_rating_returns_error(temp_warehouse):
    # Fresh DB: messages exists but message_ratings has no rows for id=1.
    result = notes.add_note(1, "foo")
    assert result.rating_id is None
    assert result.note is None
    assert result.error == "no rating yet for this message"
    assert _read_message_ratings(temp_warehouse) == []


def test_add_note_unknown_message_returns_error(temp_warehouse):
    result = notes.add_note(99999, "foo")
    assert result.error == "no rating yet for this message"


def test_add_note_picks_latest_when_multiple(temp_warehouse):
    """Two tags on the same message; the LATEST row gets the note."""
    first_id = _record_tag(1, 4)
    # Force a different rated_at so the ORDER BY rated_at DESC is unambiguous.
    time.sleep(1.1)
    second_id = _record_tag(1, 7)

    result = notes.add_note(1, "newest only")
    assert result.error is None
    assert result.rating_id == second_id

    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 2
    by_id = {r["id"]: r for r in rows}
    assert by_id[first_id]["note"] is None
    assert by_id[second_id]["note"] == "newest only"


def test_add_note_picks_latest_via_id_tiebreaker_at_same_second(temp_warehouse):
    """Same rated_at second → id DESC tiebreaker. Mirrors manual_rating.py."""
    import mml_classifier.manual_rating as mr_mod

    fixed_now = datetime(2026, 5, 9, 0, 0, 0, tzinfo=timezone.utc)

    class _FrozenDT(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: D401
            return fixed_now if tz is None else fixed_now.astimezone(tz)

    original_dt = mr_mod.datetime
    mr_mod.datetime = _FrozenDT
    try:
        first_id = _record_tag(1, 4)
        second_id = _record_tag(1, 7)
    finally:
        mr_mod.datetime = original_dt

    rows = _read_message_ratings(temp_warehouse)
    assert rows[0]["rated_at"] == rows[1]["rated_at"]

    result = notes.add_note(1, "newest")
    assert result.rating_id == second_id

    by_id = {r["id"]: r for r in _read_message_ratings(temp_warehouse)}
    assert by_id[first_id]["note"] is None
    assert by_id[second_id]["note"] == "newest"


def test_add_note_neither_input_returns_error(temp_warehouse):
    result = notes.add_note(0, "foo")
    assert result.error is not None
    assert "must supply" in result.error


def test_add_note_via_rfc_message_id(temp_warehouse):
    """Plugin's natural input — passes the RFC-822 Message-ID, sidecar resolves."""
    con = sqlite3.connect(temp_warehouse)
    try:
        con.execute(
            "UPDATE messages SET message_id = ? WHERE id = ?",
            ("<abc@example>", 1),
        )
        con.commit()
    finally:
        con.close()

    _record_tag(1, 5)
    result = notes.add_note(rfc_message_id="<abc@example>", note="via rfc")
    assert result.error is None
    assert result.note == "via rfc"

    rows = _read_message_ratings(temp_warehouse)
    assert rows[0]["note"] == "via rfc"


def test_add_note_via_unknown_rfc_message_id_returns_error(temp_warehouse):
    result = notes.add_note(rfc_message_id="<does-not-exist@example>", note="x")
    assert result.error is not None
    assert "unknown rfc_message_id" in result.error


def test_add_note_none_clears_existing(temp_warehouse):
    _record_tag(1, 5, note="v1")
    result = notes.add_note(1, None)
    assert result.error is None
    assert result.note is None
    rows = _read_message_ratings(temp_warehouse)
    assert rows[0]["note"] is None
