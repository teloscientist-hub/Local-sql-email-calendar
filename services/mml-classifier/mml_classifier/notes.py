"""Phase 3 — attach a free-text note to the most recent rating row.

The plugin posts to /add-note (Ctrl+Cmd+N flow) AFTER a bare tag has already
been recorded via /rate-message (Ctrl+Cmd+0..9 flow). This module updates the
note column in-place on the latest message_ratings row for the given message.

UPDATE semantics (not append) for the note column. The rating value remains
append-only via manual_rating.record_tag — we only mutate the per-event note,
which is metadata about a single rating event, not a state we want to log.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from . import db

log = logging.getLogger(__name__)


# ---- Result type -----------------------------------------------------------


@dataclass(frozen=True)
class AddNoteResult:
    rating_id: int | None
    note: str | None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rating_id": self.rating_id,
            "note": self.note,
            "error": self.error,
        }


# ---- Public entry point ----------------------------------------------------


def add_note(
    message_id: int | None = None,
    note: str | None = None,
    *,
    rfc_message_id: str | None = None,
) -> AddNoteResult:
    """UPDATE the latest message_ratings row's note column.

    Caller supplies either:
      - `message_id` (warehouse PK; positional for back-compat), or
      - `rfc_message_id` (RFC-822 Message-ID — the plugin's natural input).

    Empty/whitespace note → stored as NULL (treated as a delete). Lets the owner
    clear an erroneous note via Ctrl+Cmd+N → empty Enter.

    Returns AddNoteResult(rating_id, note, error). Never raises for the
    no-rating case — surfaces error="no rating yet for this message" so the
    plugin can show the inline hint and keep the overlay open.
    """
    resolved_id: int | None = None
    if isinstance(message_id, int) and message_id > 0:
        resolved_id = message_id
    elif isinstance(rfc_message_id, str) and rfc_message_id.strip():
        with db.read_only() as con:
            resolved_id = db.resolve_message_pk(rfc_message_id, con)
        if resolved_id is None:
            return AddNoteResult(
                None, None,
                error=f"unknown rfc_message_id {rfc_message_id!r}",
            )
    else:
        return AddNoteResult(
            None, None,
            error="must supply message_id (int) or rfc_message_id (str)",
        )

    note_clean: str | None = (note or "").strip() or None

    with db.read_write() as con:
        row = con.execute(
            """
            SELECT id, note FROM message_ratings
            WHERE message_id = ?
            ORDER BY rated_at DESC, id DESC
            LIMIT 1
            """,
            (resolved_id,),
        ).fetchone()
        if row is None:
            return AddNoteResult(None, None,
                                 error="no rating yet for this message")

        rating_id = row["id"]
        con.execute(
            "UPDATE message_ratings SET note = ? WHERE id = ?",
            (note_clean, rating_id),
        )
        con.commit()

    log.info("add_note: message_id=%d rating_id=%d note=%r",
             resolved_id, rating_id,
             note_clean[:60] if note_clean else None)

    return AddNoteResult(rating_id=rating_id, note=note_clean, error=None)
