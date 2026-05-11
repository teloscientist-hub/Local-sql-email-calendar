"""Unit tests for Phase 2.5 manual_rating module.

Spins up an in-memory-style SQLite DB on disk and a temp contacts_to_rate.csv.
Monkeypatches config.WAREHOUSE_DB and config.CONTACTS_CSV so the module
operates against the temp paths.
"""

from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

import pytest

from mml_classifier import config, manual_rating, ratings


# ---- Fixtures --------------------------------------------------------------


SCHEMA_SQL = """
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    sender_addr TEXT,
    sender_name TEXT,
    subject TEXT,
    received_date TEXT
);
CREATE TABLE message_classifications (
    id INTEGER PRIMARY KEY, message_id INTEGER UNIQUE,
    cluster_id INTEGER, cluster TEXT, confidence TEXT,
    classified_at TEXT, model TEXT
);
CREATE TABLE sender_classifications (
    id INTEGER PRIMARY KEY, sender_addr TEXT UNIQUE,
    cluster_id INTEGER, cluster TEXT, confidence TEXT,
    msg_count INTEGER, classified_at TEXT, classified_by TEXT, model TEXT,
    priority_friend INTEGER DEFAULT 0
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
    """Create a tiny warehouse with messages + message_ratings, return path."""
    db_path = tmp_path / "warehouse.sqlite"
    con = sqlite3.connect(db_path)
    try:
        con.executescript(SCHEMA_SQL)
        con.executemany(
            "INSERT INTO messages (id, sender_addr, sender_name) VALUES (?, ?, ?)",
            [
                (1, "alex@example.com", "Alex Example"),
                (2, "newsletter@example.com", "Example Newsletter"),
                (3, "newsender@example.com", "Brand New Sender"),
                (4, None, None),
            ],
        )
        con.commit()
    finally:
        con.close()
    return db_path


@pytest.fixture
def temp_contacts_csv(tmp_path: Path) -> Path:
    """Create a contacts_to_rate.csv with a couple of seed rows."""
    csv_path = tmp_path / "contacts_to_rate.csv"
    csv_path.write_text(
        CSV_HEADER
        + "9,Alex Example,alex@example.com,,0,0,2010,2026,16,0,\n"
        + "1,Example Newsletter,newsletter@example.com,info@example.com|news@example.com,"
        "0,0,2020,2026,6,0,\n",
        encoding="utf-8",
    )
    return csv_path


@pytest.fixture(autouse=True)
def _redirect_paths(monkeypatch, temp_warehouse, temp_contacts_csv):
    """Point both module-level config consts AND the live module at temp paths."""
    monkeypatch.setattr(config, "WAREHOUSE_DB", temp_warehouse)
    monkeypatch.setattr(config, "CONTACTS_CSV", temp_contacts_csv)
    # ratings.manual_ratings is lru_cached; make sure each test starts fresh.
    ratings.reload_ratings()
    yield


# ---- record_tag tests ------------------------------------------------------


def _read_message_ratings(db_path: Path) -> list[sqlite3.Row]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute(
            "SELECT * FROM message_ratings ORDER BY id"
        ).fetchall())
    finally:
        con.close()


def _csv_rating_for(csv_path: Path, email: str) -> str | None:
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if (row.get("email") or "").strip().lower() == email.lower():
                return row.get("rating")
    return None


def test_bare_tag_inserts_row_and_updates_csv(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        message_id=1, rating=4, note=None,
        snapshot={"rating": 9, "cluster_id": 3},
    )
    assert result.error is None
    assert result.rating_id is not None
    assert result.contact_email == "alex@example.com"
    assert result.contact_rating_updated is True

    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 1
    r = rows[0]
    assert r["rating"] == 4
    assert r["note"] is None
    assert r["system_rating_at_time"] == 9
    assert r["system_cluster_at_time"] == 3
    assert r["source"] == "plugin-keystroke"

    assert _csv_rating_for(
        temp_contacts_csv, "alex@example.com"
    ) == "4"


def test_tag_with_note_inserts_row_but_suppresses_csv(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        message_id=1, rating=3,
        note="promo blast, not a personal email",
        snapshot={"rating": 9, "cluster_id": 1},
    )
    assert result.error is None
    assert result.contact_rating_updated is False

    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 1
    assert rows[0]["note"] == "promo blast, not a personal email"

    # CSV unchanged — Alex still 9.
    assert _csv_rating_for(
        temp_contacts_csv, "alex@example.com"
    ) == "9"


def test_tag_appends_new_csv_row_when_sender_unknown(temp_warehouse, temp_contacts_csv):
    # message 3's sender (newsender@example.com) is not in the CSV.
    result = manual_rating.record_tag(
        message_id=3, rating=6, note=None,
        snapshot={"rating": 0, "cluster_id": 30},
    )
    assert result.contact_rating_updated is True
    assert _csv_rating_for(temp_contacts_csv, "newsender@example.com") == "6"


def test_tag_finds_sender_via_other_emails(temp_warehouse, temp_contacts_csv):
    # Add a message whose sender is in other_emails of an existing row.
    con = sqlite3.connect(temp_warehouse)
    try:
        con.execute(
            "INSERT INTO messages (id, sender_addr, sender_name) VALUES (?, ?, ?)",
            (10, "info@example.com", "Newsletter Alias"),
        )
        con.commit()
    finally:
        con.close()

    result = manual_rating.record_tag(
        message_id=10, rating=3, note=None, snapshot=None,
    )
    assert result.contact_rating_updated is True
    # The match was on other_emails, but the rating goes on the existing row
    # (newsletter@example.com primary).
    assert _csv_rating_for(temp_contacts_csv, "newsletter@example.com") == "3"
    # And no new row was appended for info@example.com.
    assert _csv_rating_for(temp_contacts_csv, "info@example.com") is None


def test_tag_with_empty_string_note_treated_as_no_note(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        message_id=1, rating=5, note="   ", snapshot=None,
    )
    assert result.contact_rating_updated is True
    rows = _read_message_ratings(temp_warehouse)
    assert rows[0]["note"] is None


def test_tag_zero_is_explicit_signal(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        message_id=1, rating=0, note=None, snapshot=None,
    )
    assert result.error is None
    rows = _read_message_ratings(temp_warehouse)
    assert rows[0]["rating"] == 0
    assert _csv_rating_for(
        temp_contacts_csv, "alex@example.com"
    ) == "0"


def test_tag_no_sender_addr_skips_csv_but_writes_row(temp_warehouse, temp_contacts_csv):
    # message 4 has sender_addr = NULL.
    result = manual_rating.record_tag(
        message_id=4, rating=2, note=None, snapshot=None,
    )
    assert result.error is None
    assert result.contact_email is None
    assert result.contact_rating_updated is False
    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 1


def test_invalid_rating_returns_error(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        message_id=1, rating=10, note=None, snapshot=None,
    )
    assert result.error is not None
    assert "0..9" in result.error
    assert _read_message_ratings(temp_warehouse) == []


def test_unknown_message_returns_error(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        message_id=999, rating=5, note=None, snapshot=None,
    )
    assert result.error is not None
    assert "999" in result.error
    assert _read_message_ratings(temp_warehouse) == []


def test_rate_via_rfc_message_id(temp_warehouse, temp_contacts_csv):
    """Plugin path: pass the RFC-822 Message-ID and let the sidecar resolve."""
    con = sqlite3.connect(temp_warehouse)
    try:
        con.execute(
            "UPDATE messages SET message_id = ? WHERE id = ?",
            ("<abc@example>", 1),
        )
        con.commit()
    finally:
        con.close()

    result = manual_rating.record_tag(
        rfc_message_id="<abc@example>", rating=7, note=None, snapshot=None,
    )
    assert result.error is None
    assert result.rating_id is not None
    assert result.contact_email == "alex@example.com"
    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 1
    assert rows[0]["rating"] == 7


def test_rate_via_unknown_rfc_message_id_returns_error(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        rfc_message_id="<does-not-exist@example>",
        rating=3, note=None, snapshot=None,
    )
    assert result.error is not None
    assert "unknown rfc_message_id" in result.error
    assert _read_message_ratings(temp_warehouse) == []


def test_rate_neither_input_returns_error(temp_warehouse, temp_contacts_csv):
    result = manual_rating.record_tag(
        rating=5, note=None, snapshot=None,
    )
    assert result.error is not None
    assert "must supply" in result.error
    assert _read_message_ratings(temp_warehouse) == []


def test_repeat_tagging_appends_rows(temp_warehouse, temp_contacts_csv):
    manual_rating.record_tag(
        message_id=1, rating=4, note=None, snapshot=None,
    )
    manual_rating.record_tag(
        message_id=1, rating=7, note=None, snapshot=None,
    )
    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 2
    assert [r["rating"] for r in rows] == [4, 7]
    # CSV should have the latest rating.
    assert _csv_rating_for(
        temp_contacts_csv, "alex@example.com"
    ) == "7"


# ---- effective_rating_for_message integration tests ------------------------


def test_effective_rating_returns_latest_manual_tag(temp_warehouse, temp_contacts_csv):
    """Per-message manual tag wins over per-contact and cluster default."""
    # Alex has rating 9 in CSV; cluster 30 default is 0. Without a manual
    # tag, effective rating is 9 (per-contact wins). With a tag of 4,
    # effective rating becomes 4.
    manual_rating.record_tag(
        message_id=1, rating=4,
        note="just for this one",  # note suppresses CSV update so CSV stays 9
        snapshot={"rating": 9, "cluster_id": 30},
    )
    assert ratings.effective_rating_for_message(1) == 4


def test_effective_rating_same_second_tiebreaker(temp_warehouse, temp_contacts_csv):
    """Two tags with identical rated_at — latest INSERT (id DESC) wins."""
    # Patch datetime.now() so both record_tag calls share the same timestamp.
    import mml_classifier.manual_rating as mr_mod
    from datetime import datetime, timezone

    fixed_now = datetime(2026, 5, 9, 0, 0, 0, tzinfo=timezone.utc)

    class _FrozenDT(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: D401
            return fixed_now if tz is None else fixed_now.astimezone(tz)

    original_dt = mr_mod.datetime
    mr_mod.datetime = _FrozenDT
    try:
        mr_mod.record_tag(
            message_id=1, rating=5, note=None, snapshot=None,
        )
        mr_mod.record_tag(
            message_id=1, rating=2,
            note="same second, second insert", snapshot=None,
        )
    finally:
        mr_mod.datetime = original_dt

    rows = _read_message_ratings(temp_warehouse)
    assert len(rows) == 2
    # Both share the same rated_at; tiebreaker is id DESC (latest insert wins).
    assert rows[0]["rated_at"] == rows[1]["rated_at"]
    assert ratings.effective_rating_for_message(1) == 2


def test_effective_rating_falls_through_when_no_manual_tag(temp_warehouse, temp_contacts_csv):
    """No manual tag → falls back to per-contact CSV (Alex = 9)."""
    assert ratings.effective_rating_for_message(1) == 9


def test_effective_rating_unknown_message_returns_zero(temp_warehouse, temp_contacts_csv):
    assert ratings.effective_rating_for_message(99999) == 0
