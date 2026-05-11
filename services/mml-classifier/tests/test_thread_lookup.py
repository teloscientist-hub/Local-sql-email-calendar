"""Smoke tests for thread_lookup against an in-memory SQLite fixture."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

import pytest

from mml_classifier import config, ratings, thread_lookup


SCHEMA_SQL = """
CREATE TABLE messages (
    id INTEGER PRIMARY KEY, message_id TEXT, in_reply_to TEXT,
    subject TEXT, sender_name TEXT, sender_addr TEXT,
    sent_date TEXT, received_date TEXT, body_plain TEXT, tombstone INTEGER DEFAULT 0
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
CREATE TABLE content_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER,
    importance_score REAL, tldr_text TEXT, reason TEXT,
    scorer_version TEXT, scored_at TEXT
);
"""


@pytest.fixture
def fixture_db(tmp_path, monkeypatch):
    db_path = tmp_path / "fixture.sqlite"
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA_SQL)

    # Two messages in the same logical thread; both rated newsletter (cluster 29).
    con.execute(
        "INSERT INTO messages (id, message_id, sender_addr, sender_name, "
        "subject, body_plain, received_date) VALUES "
        "(1, '<a@list.example>', 'list@example.com', 'Example List', "
        " 'Weekly digest', 'body 1', '2026-05-08T10:00:00')"
    )
    con.execute(
        "INSERT INTO messages (id, message_id, sender_addr, sender_name, "
        "subject, body_plain, received_date, in_reply_to) VALUES "
        "(2, '<b@list.example>', 'list@example.com', 'Example List', "
        " 'Re: Weekly digest', 'body 2', '2026-05-09T10:00:00', '<a@list.example>')"
    )
    con.execute(
        "INSERT INTO message_classifications (message_id, cluster_id, cluster, "
        "confidence, classified_at) VALUES "
        "(1, 29, 'Newsletters / lists', 'high', '2026-05-08T10:05:00')"
    )
    con.execute(
        "INSERT INTO message_classifications (message_id, cluster_id, cluster, "
        "confidence, classified_at) VALUES "
        "(2, 29, 'Newsletters / lists', 'high', '2026-05-09T10:05:00')"
    )
    con.execute(
        "INSERT INTO content_scores (message_id, importance_score, tldr_text, "
        "reason, scorer_version, scored_at) VALUES "
        "(1, 0.2, NULL, 'routine digest', 'content_score_v1@haiku', '2026-05-08T10:10:00')"
    )
    con.execute(
        "INSERT INTO content_scores (message_id, importance_score, tldr_text, "
        "reason, scorer_version, scored_at) VALUES "
        "(2, 0.7, 'Founder X announces YC partnership.', 'specific event', "
        " 'content_score_v1@haiku', '2026-05-09T10:10:00')"
    )
    con.commit()
    con.close()

    monkeypatch.setattr(config, "WAREHOUSE_DB", db_path)
    monkeypatch.setattr(ratings, "manual_ratings", lambda: {})
    yield db_path


def test_resolve_thread_picks_max_importance(fixture_db):
    state = thread_lookup.resolve_thread(["<a@list.example>", "<b@list.example>"])
    assert state.matched_message_count == 2
    assert state.cluster_id == 29
    assert state.cluster_name == "Newsletters / lists"
    assert state.importance_score == 0.7  # max across thread
    assert state.tldr_text == "Founder X announces YC partnership."
    assert state.rating == 1  # cluster-29 default per RATING_SCALE.md


def test_resolve_thread_unknown_ids_returns_empty(fixture_db):
    state = thread_lookup.resolve_thread(["<does-not-exist@example>"])
    assert state.matched_message_count == 0
    assert state.importance_score is None
    assert state.rating is None


def test_resolve_thread_empty_input(fixture_db):
    state = thread_lookup.resolve_thread([])
    assert state.matched_message_count == 0
