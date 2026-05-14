"""Phase 5 — draft a Google Calendar event from an email.

The plugin's Ctrl+Cmd+E flow opens an overlay immediately and fires a
background POST /draft-event {rfc_message_id}. This module is the
sidecar-side of that call. It does NOT touch Google Calendar — that's
event_creator.create_event when the user submits the overlay.

Maps the email's subject to the event title and the email's body to
the description, defaults 30 min on the next business day at 10am.
The user edits date/time in the overlay before submitting.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from html.parser import HTMLParser
from typing import Any
from zoneinfo import ZoneInfo

from . import config, db

# Tags whose contents should be dropped entirely along with the tag itself.
_DROP_TAGS = frozenset({
    "script", "style", "iframe", "object", "embed", "form", "input",
    "button", "noscript", "link", "meta", "head",
})
# Per-tag attribute allowlist. Everything else is stripped.
_ALLOW_ATTRS = {"a": {"href"}, "img": {"src", "alt"}}
_VOID_TAGS = frozenset({"br", "hr", "img", "wbr"})


class _HtmlSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._out: list[str] = []
        self._skip_depth = 0

    def _fmt_attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> str:
        allowed = _ALLOW_ATTRS.get(tag, set())
        parts: list[str] = []
        for k, v in attrs:
            if k not in allowed or v is None:
                continue
            v_escaped = v.replace('"', "&quot;")
            parts.append(f' {k}="{v_escaped}"')
        return "".join(parts)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _DROP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if ":" in tag:  # XML-namespaced tags (Office: <o:p>, <v:shape>, etc.)
            return
        self._out.append(f"<{tag}{self._fmt_attrs(tag, attrs)}>")

    def handle_endtag(self, tag: str) -> None:
        if tag in _DROP_TAGS:
            if self._skip_depth > 0:
                self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if ":" in tag or tag in _VOID_TAGS:
            return
        self._out.append(f"</{tag}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _DROP_TAGS:
            return
        if self._skip_depth or ":" in tag:
            return
        self._out.append(f"<{tag}{self._fmt_attrs(tag, attrs)}/>")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        self._out.append(data)

    def result(self) -> str:
        return "".join(self._out)


_BODY_RE = re.compile(r"<body[^>]*>(.*?)</body>", re.IGNORECASE | re.DOTALL)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _sanitize_html(raw: str) -> str:
    if not raw:
        return ""
    # Strip Outlook/MSO conditional comments and other HTML comments first;
    # HTMLParser handles them but malformed Microsoft HTML often nests
    # <head>/<style>/<script> inside conditionals in ways that confuse the
    # tag-skip state machine.
    cleaned = _COMMENT_RE.sub("", raw)
    # If a <body>...</body> exists, keep only its contents — drops <head>,
    # XML namespace boilerplate, and most generator-specific noise.
    m = _BODY_RE.search(cleaned)
    if m:
        cleaned = m.group(1)
    parser = _HtmlSanitizer()
    try:
        parser.feed(cleaned)
        parser.close()
    except Exception:  # noqa: BLE001
        return ""
    return parser.result().strip()

log = logging.getLogger(__name__)


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


def _load_message_context(con, message_id: int) -> dict[str, Any] | None:
    msg = con.execute(
        """
        SELECT id, subject, body_plain, body_html
        FROM messages
        WHERE id = ?
        """,
        (message_id,),
    ).fetchone()
    if msg is None:
        return None
    return {
        "subject": msg["subject"] or "",
        "body_plain": msg["body_plain"] or "",
        "body_html": msg["body_html"] or "",
    }


def _body_description(ctx: dict[str, Any]) -> str:
    """Return event description as HTML.

    Prefers body_html when present (sanitized). For body_plain, Mailspring's
    intake sometimes routes raw HTML into the plain column for HTML-only
    emails — detect that ("<" as first non-whitespace char) and sanitize it
    too. True plain text gets &-escaped and newline → <br>. Capped at 4000
    chars; HTML is verbose so the budget is larger than for raw plain text.
    """
    html_src = (ctx.get("body_html") or "").strip()
    if html_src:
        sanitized = _sanitize_html(html_src)
        if sanitized:
            return sanitized[:4000]
    plain = (ctx.get("body_plain") or "").strip()
    if not plain:
        return ""
    if plain.startswith("<"):
        sanitized = _sanitize_html(plain)
        if sanitized:
            return sanitized[:4000]
    escaped = (
        plain.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;")
             .replace("\r\n", "\n")
             .replace("\n", "<br>")
    )
    return escaped[:4000]


# ---- Public entry point ----------------------------------------------------


def draft_event(
    *,
    message_id: int | None = None,
    rfc_message_id: str | None = None,
) -> EventDraftResult:
    """Draft a calendar event from the given email.

    Caller supplies either `message_id` (warehouse PK) or `rfc_message_id`
    (RFC-822 Message-ID — the plugin's natural input).

    Deterministic: title = subject, description = body, duration = 30,
    start = next business day 10am. The overlay lets the user override
    everything before submitting.
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
                confidence="high",
                error=f"unknown rfc_message_id {rfc_message_id!r}",
            )
    else:
        return EventDraftResult(
            source_message_id=None,
            title=None, description=None,
            proposed_start_iso=_fallback_start_iso(),
            duration_minutes=30, attendees=[],
            confidence="high",
            error="must supply message_id (int) or rfc_message_id (str)",
        )

    with db.read_only() as con:
        ctx = _load_message_context(con, resolved_id)

    if ctx is None:
        return EventDraftResult(
            source_message_id=resolved_id,
            title=None, description=None,
            proposed_start_iso=_fallback_start_iso(),
            duration_minutes=30, attendees=[],
            confidence="high",
            error=f"message_id {resolved_id} not found",
        )

    return EventDraftResult(
        source_message_id=resolved_id,
        title=(ctx["subject"] or "").strip()[:200] or None,
        description=_body_description(ctx) or None,
        proposed_start_iso=_fallback_start_iso(),
        duration_minutes=30,
        attendees=[],
        confidence="high",
        error=None,
    )
