"""SQLite connection helpers. Read-mostly with append-only writes to content_scores."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

from . import config


def _uri(db_path: Path, *, mode: str) -> str:
    # file:/abs/path?mode=ro — handles spaces & curly apostrophes correctly via percent-encoding.
    return f"file:{quote(str(db_path))}?mode={mode}"


@contextmanager
def read_only():
    con = sqlite3.connect(_uri(config.WAREHOUSE_DB, mode="ro"), uri=True)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()


@contextmanager
def read_write():
    con = sqlite3.connect(_uri(config.WAREHOUSE_DB, mode="rw"), uri=True)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()


def resolve_message_pk(rfc_message_id: str, con: sqlite3.Connection) -> int | None:
    """RFC-822 Message-ID → warehouse messages.id.

    Returns the most recent matching row's id, or None if no match.
    The same RFC-ID can in principle appear in multiple imports; we pick the
    most recent received_date with id DESC as a deterministic tiebreaker.
    """
    cleaned = (rfc_message_id or "").strip()
    if not cleaned:
        return None
    r = con.execute(
        "SELECT id FROM messages WHERE message_id = ? "
        "ORDER BY received_date DESC, id DESC LIMIT 1",
        (cleaned,),
    ).fetchone()
    return int(r["id"]) if r else None
