"""Phase 5 — write a Google Calendar event and mirror it into the warehouse.

Plugin POSTs /create-event after the user reviews the overlay. This module:
  1. Validates the payload.
  2. Looks up the default calendar (or the requested calendar_pk).
  3. Builds the GCal events.insert body.
  4. Calls gcal_client.insert_event.
  5. Writes the result into the unified calendar schema:
       - events (source='plugin-create')
       - event_attendees (one row per attendee)
       - event_changes (one 'plugin-create' history row with the GCal response)

The same `events` table is later refreshed by `calendar_intake` when ingest
pulls the row from Google's sync feed — source='plugin-create' stays sticky,
Google-state fields (etag, status, attendee response_status) get updated.

Returns a typed result; the HTTP handler always returns 200 with `error`
populated on any failure. The plugin reads `error` and keeps the overlay
open on failure so the user can retry.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from . import config, db, gcal_client, gcal_oauth

log = logging.getLogger(__name__)


# ---- Result type -----------------------------------------------------------


@dataclass(frozen=True)
class EventCreateResult:
    calendar_event_id: int | None
    gcal_event_id: str | None
    html_link: str | None
    title: str | None
    start_iso: str | None
    end_iso: str | None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "calendar_event_id": self.calendar_event_id,
            "gcal_event_id": self.gcal_event_id,
            "html_link": self.html_link,
            "title": self.title,
            "start_iso": self.start_iso,
            "end_iso": self.end_iso,
            "error": self.error,
        }


# ---- Helpers --------------------------------------------------------------


_ISO_TZ_RE = re.compile(r"(Z|[+\-]\d{2}:?\d{2})$")


def _parse_iso(s: str) -> datetime:
    """Parse ISO-8601 datetime. Accepts trailing 'Z' as UTC."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def _ensure_tz(iso: str, fallback_tz: str) -> str:
    """If the ISO string has no offset, append the calendar's timezone offset."""
    if _ISO_TZ_RE.search(iso):
        return iso
    # No offset → reformat as naive + let GCal interpret per timeZone field below.
    return iso


def _resolve_calendar(con, calendar_pk: int | None) -> tuple[int, str, str] | None:
    """Return (calendar_pk, gcal_calendar_id, timezone) or None if not found.

    If calendar_pk is None, picks the row with is_default=1.
    """
    if calendar_pk is not None:
        row = con.execute(
            "SELECT id, gcal_calendar_id, COALESCE(timezone, ?) AS timezone "
            "FROM calendars WHERE id = ? AND COALESCE(tombstone,0)=0",
            (config.GCAL_TIMEZONE, calendar_pk),
        ).fetchone()
    else:
        row = con.execute(
            "SELECT id, gcal_calendar_id, COALESCE(timezone, ?) AS timezone "
            "FROM calendars WHERE is_default = 1 AND COALESCE(tombstone,0)=0 "
            "LIMIT 1",
            (config.GCAL_TIMEZONE,),
        ).fetchone()
    if row is None:
        return None
    return int(row["id"]), str(row["gcal_calendar_id"]), str(row["timezone"])


# ---- Public entry point ---------------------------------------------------


def create_event(payload: dict[str, Any]) -> EventCreateResult:
    """Validate, write to GCal, mirror into the warehouse.

    Expected payload keys:
        title           (str, required, ≤200 chars)
        start_iso       (str, required, ISO-8601 with or without tz offset)
        duration_minutes (int, required, > 0)
        description     (str, optional)
        attendees       (list[{email, name?}], optional)
        rfc_message_id  (str, optional — links event to source email)
        message_id      (int, optional — alternative to rfc_message_id)
        calendar_pk     (int, optional — picks default calendar if omitted)
        plugin_version  (str, optional)
        llm_drafted     (bool, optional — defaults true)
    """
    title_raw = payload.get("title")
    if not isinstance(title_raw, str) or not title_raw.strip():
        return EventCreateResult(None, None, None, None, None, None,
                                 error="title is required (string)")
    title = title_raw.strip()[:200]

    start_raw = payload.get("start_iso")
    if not isinstance(start_raw, str) or not start_raw.strip():
        return EventCreateResult(None, None, None, None, None, None,
                                 error="start_iso is required (ISO 8601 string)")
    start_iso = start_raw.strip()
    try:
        start_dt = _parse_iso(start_iso)
    except ValueError as e:
        return EventCreateResult(None, None, None, None, None, None,
                                 error=f"invalid start_iso: {e}")

    duration = payload.get("duration_minutes")
    if not isinstance(duration, int) or duration <= 0:
        return EventCreateResult(None, None, None, None, None, None,
                                 error="duration_minutes must be a positive int")

    end_dt = start_dt + timedelta(minutes=duration)
    end_iso = end_dt.isoformat(timespec="seconds")

    description_raw = payload.get("description")
    description = description_raw.strip()[:2000] if isinstance(description_raw, str) else None

    attendees_in = payload.get("attendees") or []
    attendees: list[dict[str, Any]] = []
    if isinstance(attendees_in, list):
        for a in attendees_in:
            if not isinstance(a, dict):
                continue
            email = (a.get("email") or "").strip().lower()
            if not email or "@" not in email:
                continue
            entry: dict[str, Any] = {"email": email}
            name = a.get("name")
            if isinstance(name, str) and name.strip():
                entry["displayName"] = name.strip()
            attendees.append(entry)

    # Source message linkage.
    source_message_id: int | None = None
    msg_id_raw = payload.get("message_id")
    rfc_id_raw = payload.get("rfc_message_id")
    if isinstance(msg_id_raw, int) and msg_id_raw > 0:
        source_message_id = msg_id_raw
    elif isinstance(rfc_id_raw, str) and rfc_id_raw.strip():
        with db.read_only() as con:
            source_message_id = db.resolve_message_pk(rfc_id_raw, con)
        # Unknown RFC ID is non-fatal — we still create the event, just unlinked.
        if source_message_id is None:
            log.info("create_event: rfc_message_id %r not in warehouse; "
                     "creating event without source link", rfc_id_raw)

    calendar_pk_in = payload.get("calendar_pk")
    calendar_pk_arg = calendar_pk_in if isinstance(calendar_pk_in, int) else None

    plugin_version = payload.get("plugin_version") if isinstance(payload.get("plugin_version"), str) else None
    llm_drafted = bool(payload.get("llm_drafted", True))

    with db.read_only() as con:
        resolved = _resolve_calendar(con, calendar_pk_arg)
    if resolved is None:
        return EventCreateResult(
            None, None, None, None, None, None,
            error=(
                "no default calendar configured. "
                "Run: python -m mml_classifier.gcal_oauth_setup"
            ),
        )
    cal_pk, gcal_calendar_id, calendar_tz = resolved

    # Build the GCal event body. If start_iso lacks a tz offset, we still
    # send the calendar's timezone so GCal interprets correctly.
    has_tz = bool(_ISO_TZ_RE.search(start_iso))
    body: dict[str, Any] = {
        "summary": title,
        "start": {
            "dateTime": start_iso if has_tz else start_dt.isoformat(timespec="seconds"),
            "timeZone": calendar_tz,
        },
        "end": {
            "dateTime": end_iso,
            "timeZone": calendar_tz,
        },
    }
    if description:
        body["description"] = description
    if attendees:
        body["attendees"] = attendees

    try:
        resp = gcal_client.insert_event(gcal_calendar_id, body)
    except gcal_oauth.GcalAuthError as e:
        return EventCreateResult(None, None, None, title, start_iso, end_iso,
                                 error=str(e))
    except gcal_client.GcalApiError as e:
        return EventCreateResult(None, None, None, title, start_iso, end_iso,
                                 error=str(e))
    except Exception as e:  # noqa: BLE001
        log.exception("create_event: unexpected GCal failure")
        return EventCreateResult(None, None, None, title, start_iso, end_iso,
                                 error=f"gcal call failed: {e}")

    gcal_event_id = resp.get("id")
    html_link = resp.get("htmlLink")
    gcal_etag = resp.get("etag")
    gcal_status = resp.get("status")
    gcal_visibility = resp.get("visibility")
    gcal_transparency = resp.get("transparency")
    gcal_hangout_link = resp.get("hangoutLink")
    gcal_created = resp.get("created")
    gcal_updated = resp.get("updated")
    gcal_ical_uid = resp.get("iCalUID")
    organizer = resp.get("organizer") or {}
    organizer_email = (organizer.get("email") or "").strip().lower() or None
    organizer_self = 1 if organizer.get("self") else 0

    # GCal returns attendees with response_status, organizer flag, etc.
    # Prefer that over our submitted list — it has the canonical state.
    resp_attendees = resp.get("attendees")
    if not isinstance(resp_attendees, list):
        resp_attendees = []
    attendee_rows: list[dict[str, Any]] = []
    for a in resp_attendees:
        if not isinstance(a, dict):
            continue
        email = (a.get("email") or "").strip().lower()
        if not email or "@" not in email:
            continue
        attendee_rows.append({
            "email": email,
            "display_name": a.get("displayName") if isinstance(a.get("displayName"), str) else None,
            "response_status": a.get("responseStatus") if isinstance(a.get("responseStatus"), str) else None,
            "is_organizer": 1 if a.get("organizer") else 0,
            "is_optional": 1 if a.get("optional") else 0,
            "is_self": 1 if a.get("self") else 0,
            "is_resource": 1 if a.get("resource") else 0,
        })
    # If Google didn't echo back attendees (some events get auto-stripped),
    # fall back to what we sent so we still have a record.
    if not attendee_rows and attendees:
        for a in attendees:
            attendee_rows.append({
                "email": a["email"],
                "display_name": a.get("displayName") if isinstance(a.get("displayName"), str) else None,
                "response_status": None,
                "is_organizer": 0, "is_optional": 0, "is_self": 0, "is_resource": 0,
            })

    with db.read_write() as con:
        con.execute("BEGIN")
        try:
            cur = con.execute(
                """
                INSERT INTO events
                    (calendar_pk, gcal_event_id, ical_uid, title, description,
                     start_iso, end_iso, timezone, status, organizer_email,
                     organizer_self, visibility, transparency, etag, html_link,
                     hangout_link, created_at_google, updated_at_google,
                     source_message_id, source, llm_drafted, plugin_version,
                     sidecar_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                        ?, 'plugin-create', ?, ?, ?)
                """,
                (
                    cal_pk, gcal_event_id, gcal_ical_uid, title, description,
                    start_iso, end_iso, calendar_tz, gcal_status, organizer_email,
                    organizer_self, gcal_visibility, gcal_transparency, gcal_etag,
                    html_link, gcal_hangout_link, gcal_created, gcal_updated,
                    source_message_id, 1 if llm_drafted else 0,
                    plugin_version, config.INGESTER_VERSION,
                ),
            )
            new_id = int(cur.lastrowid)

            for ar in attendee_rows:
                con.execute(
                    """
                    INSERT INTO event_attendees
                        (event_id, email, display_name, response_status,
                         is_organizer, is_optional, is_self, is_resource)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_id, ar["email"], ar["display_name"], ar["response_status"],
                        ar["is_organizer"], ar["is_optional"], ar["is_self"], ar["is_resource"],
                    ),
                )

            con.execute(
                """
                INSERT INTO event_changes
                    (event_id, etag_after, change_kind, diff_json, snapshot_json)
                VALUES (?, ?, 'plugin-create', NULL, ?)
                """,
                (new_id, gcal_etag, json.dumps(resp)),
            )
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise

    log.info(
        "create_event: gcal_event_id=%s cal_pk=%d source_message_id=%s title=%r attendees=%d",
        gcal_event_id, cal_pk, source_message_id, title[:60], len(attendee_rows),
    )

    return EventCreateResult(
        calendar_event_id=new_id,
        gcal_event_id=gcal_event_id,
        html_link=html_link,
        title=title,
        start_iso=start_iso,
        end_iso=end_iso,
        error=None,
    )
