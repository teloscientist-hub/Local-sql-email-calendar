"""Thin wrapper around the Google Calendar API.

The sidecar talks to GCal through this module; nothing else imports
googleapiclient directly. Single lazily-built service instance — we
rebuild only if credentials change (refresh persists new state, but the
service binding's `credentials` object refreshes in place).

Exposes:
    insert_event(calendar_id, body) → dict (the API response)
    list_calendars()                → list[dict] (CalendarListEntry items)
    primary_account_email()         → str | None
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from . import gcal_oauth

log = logging.getLogger(__name__)


class GcalApiError(RuntimeError):
    """API-side failure surfaced as a user-readable message."""


_service = None
_service_lock = threading.Lock()


def _get_service():
    """Lazy single-flight service. Rebuilds if credentials object differs."""
    global _service
    with _service_lock:
        creds = gcal_oauth.get_credentials()
        if _service is None or getattr(_service, "_mml_creds", None) is not creds:
            _service = build(
                "calendar", "v3", credentials=creds, cache_discovery=False
            )
            _service._mml_creds = creds  # type: ignore[attr-defined]
        return _service


def insert_event(calendar_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """events.insert. Returns the created event resource as a dict."""
    svc = _get_service()
    try:
        return svc.events().insert(calendarId=calendar_id, body=body).execute()
    except HttpError as e:
        # The HttpError's str() includes the URL + status code; trim it.
        raise GcalApiError(
            f"gcal events.insert failed for calendar={calendar_id!r}: {e}"
        ) from e


def list_calendars() -> list[dict[str, Any]]:
    """calendarList.list. Returns the `items` array (each is a dict).

    Useful for the one-time setup (seeding `calendars` rows) and a future
    multi-account / multi-calendar picker.
    """
    svc = _get_service()
    items: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        try:
            resp = svc.calendarList().list(pageToken=page_token).execute()
        except HttpError as e:
            raise GcalApiError(f"gcal calendarList.list failed: {e}") from e
        items.extend(resp.get("items", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return items


def primary_account_email() -> str | None:
    """Get the account email from the primary calendar entry.

    `calendarList` primary entry has `id == 'primary'` or its `id` equals
    the account email. We probe and return whichever resolves.
    """
    for entry in list_calendars():
        if entry.get("primary") is True:
            cid = entry.get("id")
            if isinstance(cid, str) and "@" in cid:
                return cid
    return None
