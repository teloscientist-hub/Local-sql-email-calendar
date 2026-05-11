"""Phase 5 — draft a Google Calendar event from an email using Claude.

The plugin's Ctrl+Cmd+E flow opens an overlay immediately and fires a
background POST /draft-event {rfc_message_id}. This module is the
sidecar-side of that call. It does NOT touch Google Calendar — that's
event_creator.create_event when the user submits the overlay.

Reads the message body, subject, and recipients from the warehouse,
filters out the owner's own addresses from the attendee suggestion, calls
Claude with the draft_event_v1.md prompt + JSON schema, and returns a
typed result the HTTP handler serializes back to the plugin.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from . import claude_cli, config, db

log = logging.getLogger(__name__)


# ---- JSON schema (Claude --json-schema validates against this) -------------

DRAFT_EVENT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "maxLength": 200},
        "description": {"type": "string", "maxLength": 2000},
        "proposed_start_iso": {"type": "string"},
        "duration_minutes": {
            "type": "integer",
            "enum": [15, 30, 45, 60, 90],
        },
        "attendees": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "email": {"type": "string"},
                    "name": {"type": "string"},
                },
                "required": ["email"],
                "additionalProperties": False,
            },
        },
        "confidence": {"type": "string", "enum": ["high", "low"]},
    },
    "required": [
        "title", "description", "proposed_start_iso",
        "duration_minutes", "attendees", "confidence",
    ],
    "additionalProperties": False,
}


# ---- Result type -----------------------------------------------------------


@dataclass(frozen=True)
class Attendee:
    email: str
    name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"email": self.email}
        if self.name:
            out["name"] = self.name
        return out


@dataclass(frozen=True)
class EventDraftResult:
    source_message_id: int | None
    title: str | None
    description: str | None
    proposed_start_iso: str | None
    duration_minutes: int | None
    attendees: list[Attendee] = field(default_factory=list)
    confidence: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_message_id": self.source_message_id,
            "title": self.title,
            "description": self.description,
            "proposed_start_iso": self.proposed_start_iso,
            "duration_minutes": self.duration_minutes,
            "attendees": [a.to_dict() for a in self.attendees],
            "confidence": self.confidence,
            "error": self.error,
        }


# ---- Helpers --------------------------------------------------------------


def _load_system_prompt() -> str:
    path = config.PROMPTS_DIR / f"{config.EVENT_DRAFTER_PROMPT_VERSION}.md"
    return path.read_text(encoding="utf-8")


def _fallback_start_iso() -> str:
    """Next business day at 10:00 in the configured local timezone."""
    try:
        tz = ZoneInfo(config.GCAL_TIMEZONE)
    except Exception:  # noqa: BLE001
        tz = timezone.utc
    now = datetime.now(tz)
    candidate = (now + timedelta(days=1)).date()
    # Skip Sat/Sun (weekday() returns 0=Mon..6=Sun).
    while candidate.weekday() >= 5:
        candidate = candidate + timedelta(days=1)
    return datetime.combine(candidate, time(10, 0), tzinfo=tz).isoformat(timespec="seconds")


def _load_me_addresses(con) -> set[str]:
    rows = con.execute("SELECT LOWER(email) AS e FROM me_addresses").fetchall()
    return {r["e"] for r in rows if r["e"]}


def _load_message_context(con, message_id: int) -> dict[str, Any] | None:
    msg = con.execute(
        """
        SELECT id, subject, sender_name, sender_addr, body_plain, body_html,
               sent_date, received_date
        FROM messages
        WHERE id = ?
        """,
        (message_id,),
    ).fetchone()
    if msg is None:
        return None
    recipients = con.execute(
        """
        SELECT kind, name, LOWER(addr) AS addr
        FROM recipients
        WHERE message_id = ?
          AND COALESCE(tombstone, 0) = 0
        """,
        (message_id,),
    ).fetchall()
    return {
        "subject": msg["subject"] or "",
        "sender_name": msg["sender_name"] or "",
        "sender_addr": (msg["sender_addr"] or "").strip().lower(),
        "body_plain": msg["body_plain"] or "",
        "body_html": msg["body_html"] or "",
        "sent_date": msg["sent_date"],
        "received_date": msg["received_date"],
        "recipients": [
            {"kind": r["kind"], "name": r["name"] or "", "addr": r["addr"] or ""}
            for r in recipients
        ],
    }


def _format_user_prompt(ctx: dict[str, Any], me_addrs: set[str]) -> str:
    body = (ctx["body_plain"] or "").strip()
    if not body and ctx["body_html"]:
        # Best-effort HTML strip — keep it simple; the prompt is robust to noise.
        import re
        body = re.sub(r"<[^>]+>", " ", ctx["body_html"])
        body = re.sub(r"\s+", " ", body).strip()
    if len(body) > config.BODY_MAX_CHARS:
        body = body[: config.BODY_MAX_CHARS] + "\n\n[...truncated]"

    to_list = ", ".join(
        f"{r['name']} <{r['addr']}>".strip()
        for r in ctx["recipients"]
        if r["kind"] == "to" and r["addr"]
    ) or "(none)"
    cc_list = ", ".join(
        f"{r['name']} <{r['addr']}>".strip()
        for r in ctx["recipients"]
        if r["kind"] == "cc" and r["addr"]
    ) or "(none)"

    me_list = ", ".join(sorted(me_addrs)) if me_addrs else "(none)"

    return (
        f"The owner's own addresses (do NOT include as attendees): {me_list}\n"
        f"\n"
        f"From: {ctx['sender_name']} <{ctx['sender_addr']}>\n"
        f"To:   {to_list}\n"
        f"Cc:   {cc_list}\n"
        f"Date: {ctx['received_date'] or ctx['sent_date'] or 'unknown'}\n"
        f"Subject: {ctx['subject']}\n"
        f"\n"
        f"---\n"
        f"{body}\n"
        f"---\n"
    )


def _normalize_attendees(raw: Any, me_addrs: set[str]) -> list[Attendee]:
    if not isinstance(raw, list):
        return []
    out: list[Attendee] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        email = (item.get("email") or "").strip().lower()
        if not email or "@" not in email or email in me_addrs or email in seen:
            continue
        seen.add(email)
        name_raw = item.get("name")
        name = name_raw.strip() if isinstance(name_raw, str) and name_raw.strip() else None
        out.append(Attendee(email=email, name=name))
    return out


# ---- Public entry point ----------------------------------------------------


def draft_event(
    *,
    message_id: int | None = None,
    rfc_message_id: str | None = None,
) -> EventDraftResult:
    """Draft a calendar event from the given email.

    Caller supplies either `message_id` (warehouse PK) or `rfc_message_id`
    (RFC-822 Message-ID — the plugin's natural input).

    Always returns an EventDraftResult — never raises. On LLM failure or
    DB miss, sets `error` and provides best-effort defaults (today+1 10am,
    duration 30, empty attendees) so the overlay can still render an
    editable form.
    """
    resolved_id: int | None = None
    if isinstance(message_id, int) and message_id > 0:
        resolved_id = message_id
    elif isinstance(rfc_message_id, str) and rfc_message_id.strip():
        with db.read_only() as con:
            resolved_id = db.resolve_message_pk(rfc_message_id, con)
        if resolved_id is None:
            return EventDraftResult(
                source_message_id=None,
                title=None, description=None,
                proposed_start_iso=_fallback_start_iso(),
                duration_minutes=30, attendees=[],
                confidence="low",
                error=f"unknown rfc_message_id {rfc_message_id!r}",
            )
    else:
        return EventDraftResult(
            source_message_id=None,
            title=None, description=None,
            proposed_start_iso=_fallback_start_iso(),
            duration_minutes=30, attendees=[],
            confidence="low",
            error="must supply message_id (int) or rfc_message_id (str)",
        )

    with db.read_only() as con:
        ctx = _load_message_context(con, resolved_id)
        me_addrs = _load_me_addresses(con)

    if ctx is None:
        return EventDraftResult(
            source_message_id=resolved_id,
            title=None, description=None,
            proposed_start_iso=_fallback_start_iso(),
            duration_minutes=30, attendees=[],
            confidence="low",
            error=f"message_id {resolved_id} not found",
        )

    try:
        system_prompt = _load_system_prompt()
        user_prompt = _format_user_prompt(ctx, me_addrs)
        out = claude_cli.call(
            user_prompt,
            system=system_prompt,
            json_schema=DRAFT_EVENT_SCHEMA,
        )
    except claude_cli.ClaudeCallError as e:
        log.warning("draft_event: LLM call failed for message_id=%d: %s", resolved_id, e)
        # Subject as best-effort title; rest stays empty.
        return EventDraftResult(
            source_message_id=resolved_id,
            title=(ctx["subject"] or None),
            description=None,
            proposed_start_iso=_fallback_start_iso(),
            duration_minutes=30, attendees=[],
            confidence="low",
            error=f"llm draft unavailable: {e}",
        )
    except Exception as e:  # noqa: BLE001
        log.exception("draft_event: unexpected failure for message_id=%d", resolved_id)
        return EventDraftResult(
            source_message_id=resolved_id,
            title=(ctx["subject"] or None),
            description=None,
            proposed_start_iso=_fallback_start_iso(),
            duration_minutes=30, attendees=[],
            confidence="low",
            error=f"draft failed: {e}",
        )

    title = (out.get("title") or "").strip()[:200] or None
    description = (out.get("description") or "").strip()[:2000] or None
    start_iso = (out.get("proposed_start_iso") or "").strip() or _fallback_start_iso()
    raw_duration = out.get("duration_minutes")
    duration = raw_duration if isinstance(raw_duration, int) and raw_duration in (15, 30, 45, 60, 90) else 30
    attendees = _normalize_attendees(out.get("attendees"), me_addrs)
    confidence = out.get("confidence") if out.get("confidence") in ("high", "low") else "low"

    return EventDraftResult(
        source_message_id=resolved_id,
        title=title,
        description=description,
        proposed_start_iso=start_iso,
        duration_minutes=duration,
        attendees=attendees,
        confidence=confidence,
        error=None,
    )
