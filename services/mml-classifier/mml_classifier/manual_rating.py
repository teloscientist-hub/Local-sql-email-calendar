"""Phase 2.5 — manual 0–9 message tagging from the Mailspring plugin.

The plugin posts to /rate-message; the handler calls record_tag() here.
Two side effects per call:

    1. INSERT into message_ratings with full provenance (always).
    2. Upsert sender's row in contacts_to_rate.csv with the new rating
       (only when there's no note — a tag-with-note is context-conditional
       and shouldn't move the per-contact baseline).

Append-only — re-tagging inserts a new row; latest by rated_at DESC wins.
"""

from __future__ import annotations

import csv
import fcntl
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config, db, ratings

log = logging.getLogger(__name__)


# ---- Result type -----------------------------------------------------------


@dataclass(frozen=True)
class TagResult:
    rating_id: int | None
    rated_at: str | None
    contact_email: str | None
    contact_rating_updated: bool
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rating_id": self.rating_id,
            "rated_at": self.rated_at,
            "contact_email": self.contact_email,
            "contact_rating_updated": self.contact_rating_updated,
            "error": self.error,
        }


# ---- Public entry point ----------------------------------------------------


def record_tag(
    *,
    message_id: int | None = None,
    rfc_message_id: str | None = None,
    rating: int,
    note: str | None,
    snapshot: dict[str, Any] | None,
    plugin_version: str | None = None,
) -> TagResult:
    """Persist a manual rating tag.

    Caller supplies either:
      - `message_id` (warehouse PK), or
      - `rfc_message_id` (RFC-822 Message-ID from Mailspring's headerMessageId).
    The latter is the plugin's natural input; sidecar resolves to PK.

    Validates inputs, looks up the sender, INSERTs a message_ratings row,
    and (when no note is present and the sender resolves) upserts the
    contacts_to_rate.csv row for that sender.

    Returns a TagResult with `error` populated on validation failure.
    The HTTP handler returns 200 either way; the plugin reads `error`.
    """
    if not isinstance(rating, int) or not 0 <= rating <= 9:
        return TagResult(None, None, None, False,
                         error="rating must be int 0..9")

    resolved_id: int | None = None
    if isinstance(message_id, int) and message_id > 0:
        resolved_id = message_id
    elif isinstance(rfc_message_id, str) and rfc_message_id.strip():
        with db.read_only() as con:
            resolved_id = db.resolve_message_pk(rfc_message_id, con)
        if resolved_id is None:
            return TagResult(None, None, None, False,
                             error=f"unknown rfc_message_id {rfc_message_id!r}")
    else:
        return TagResult(None, None, None, False,
                         error="must supply message_id (int) or rfc_message_id (str)")

    with db.read_only() as con:
        row = con.execute(
            "SELECT sender_addr FROM messages WHERE id = ?",
            (resolved_id,),
        ).fetchone()
    if row is None:
        return TagResult(None, None, None, False,
                         error=f"unknown message_id {resolved_id}")
    message_id = resolved_id

    sender_addr = (row["sender_addr"] or "").strip().lower() or None

    note_clean = (note or "").strip() or None
    snap = snapshot or {}
    sys_rating = snap.get("rating")
    sys_cluster = snap.get("cluster_id")
    rated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with db.read_write() as con:
        cur = con.execute(
            """
            INSERT INTO message_ratings
              (message_id, rating, note, rated_at,
               system_rating_at_time, system_cluster_at_time,
               source, plugin_version, sidecar_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (message_id, rating, note_clean, rated_at,
             sys_rating, sys_cluster,
             "plugin-keystroke", plugin_version, config.INGESTER_VERSION),
        )
        rating_id = cur.lastrowid
        con.commit()

    contact_rating_updated = False
    if note_clean is None and sender_addr is not None:
        try:
            update_contact_csv(sender_addr, rating)
            contact_rating_updated = True
        except Exception as e:  # noqa: BLE001
            # The DB row is written; CSV failure is non-fatal but worth surfacing.
            log.warning("contacts_to_rate.csv update failed for %s: %s",
                        sender_addr, e)

    return TagResult(
        rating_id=rating_id,
        rated_at=rated_at,
        contact_email=sender_addr,
        contact_rating_updated=contact_rating_updated,
    )


# ---- contacts_to_rate.csv writer -------------------------------------------


def update_contact_csv(sender_addr: str, rating: int) -> None:
    """Atomic upsert of the sender's row in contacts_to_rate.csv.

    Read all rows, find the row whose `email` or any pipe-delimited
    `other_emails` entry matches (lowercase), update its `rating`. If
    no row matches, append a new row with email = sender_addr.

    Writes go to a temp file in the same directory, then os.replace
    onto the target — so a crash mid-write can't corrupt the original.
    A shared lock guards the read; an exclusive lock guards the write.

    On success, drops ratings.manual_ratings()'s LRU cache so the next
    effective_rating call re-reads the CSV.
    """
    sender = sender_addr.strip().lower()
    if not sender:
        raise ValueError("empty sender_addr")

    csv_path: Path = config.CONTACTS_CSV
    if not csv_path.exists():
        raise FileNotFoundError(f"contacts_to_rate.csv not found: {csv_path}")

    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_SH)
        try:
            reader = csv.DictReader(fh)
            fieldnames = reader.fieldnames
            rows = list(reader)
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    if not fieldnames:
        raise ValueError(f"empty or malformed CSV header: {csv_path}")

    updated = False
    for row in rows:
        primary = (row.get("email") or "").strip().lower()
        alts_raw = row.get("other_emails") or ""
        alts = {a.strip().lower() for a in alts_raw.split("|") if a.strip()}
        if primary == sender or sender in alts:
            row["rating"] = str(rating)
            updated = True
            break

    if not updated:
        new_row = {fn: "" for fn in fieldnames}
        if "rating" in new_row:
            new_row["rating"] = str(rating)
        if "email" in new_row:
            new_row["email"] = sender
        rows.append(new_row)

    tmp_path = csv_path.with_suffix(csv_path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8", newline="") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
            fh.flush()
            os.fsync(fh.fileno())
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    os.replace(tmp_path, csv_path)
    ratings.reload_ratings()
