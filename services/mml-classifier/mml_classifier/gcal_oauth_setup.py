"""One-time CLI: complete the Google OAuth flow and seed `calendars`.

Usage:
    python -m mml_classifier.gcal_oauth_setup

What it does:
  1. Reads OAuth2 client secrets from config.GCAL_CLIENT_SECRETS_PATH.
  2. Runs google-auth-oauthlib InstalledAppFlow.run_local_server(), which
     opens a browser, completes consent, and returns Credentials.
  3. Persists Credentials JSON (with refresh_token) to GCAL_TOKEN_PATH.
  4. Calls the Calendar API to find the user's primary calendar.
  5. Upserts a row into `calendars` with is_default=1.

Idempotent — re-running re-consents (the user can re-grant) and re-upserts.
"""

from __future__ import annotations

import argparse
import logging
import sys
from typing import Any

from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from . import config, db


def _run_consent() -> Any:
    secrets_path = config.GCAL_CLIENT_SECRETS_PATH
    if not secrets_path.exists():
        print(
            f"ERROR: client secrets not found at {secrets_path}\n"
            "  1. Visit https://console.cloud.google.com/apis/credentials\n"
            "  2. Create OAuth2 credentials → Desktop application\n"
            f"  3. Download client_secret_*.json and save as: {secrets_path}\n",
            file=sys.stderr,
        )
        sys.exit(2)

    flow = InstalledAppFlow.from_client_secrets_file(
        str(secrets_path), scopes=list(config.GCAL_SCOPES)
    )
    creds = flow.run_local_server(port=0, open_browser=True)
    return creds


def _persist_token(creds: Any) -> None:
    config.GCAL_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.GCAL_TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    print(f"OK: token saved to {config.GCAL_TOKEN_PATH}")


def _seed_calendars(creds: Any) -> None:
    """Call calendarList.list and upsert a row for the primary calendar.

    Sets both is_default=1 (Phase 5 picks this calendar when /create-event
    omits one) and is_primary=1 (this is the account's primary calendar
    per Google). Description is captured if Google returns one.
    """
    svc = build("calendar", "v3", credentials=creds, cache_discovery=False)
    entries = svc.calendarList().list().execute().get("items", [])
    primary = next((e for e in entries if e.get("primary")), None)
    description: str | None
    if primary is None:
        print(
            "WARN: no 'primary' calendar entry found via calendarList.list. "
            "Falling back to a 'primary'-ID row.",
            file=sys.stderr,
        )
        gcal_id = "primary"
        display_name = "Primary"
        timezone = config.GCAL_TIMEZONE
        description = None
        account = config.GCAL_GOOGLE_ACCOUNT
    else:
        gcal_id = primary.get("id", "primary")
        display_name = primary.get("summary") or "Primary"
        timezone = primary.get("timeZone") or config.GCAL_TIMEZONE
        description = primary.get("description") if isinstance(primary.get("description"), str) else None
        # The primary calendar's id is usually the account email itself.
        account = gcal_id if "@" in gcal_id else config.GCAL_GOOGLE_ACCOUNT

    with db.read_write() as con:
        # Clear any existing default flag so there's only one default.
        con.execute("UPDATE calendars SET is_default = 0 WHERE is_default = 1")
        con.execute(
            """
            INSERT INTO calendars
                (google_account, gcal_calendar_id, display_name, description,
                 timezone, is_default, is_primary, source, ingester_version,
                 synced_at)
            VALUES (?, ?, ?, ?, ?, 1, 1, 'google', ?, datetime('now'))
            ON CONFLICT(google_account, gcal_calendar_id) DO UPDATE SET
                display_name     = excluded.display_name,
                description      = excluded.description,
                timezone         = excluded.timezone,
                is_default       = 1,
                is_primary       = 1,
                source           = 'google',
                ingester_version = excluded.ingester_version,
                synced_at        = excluded.synced_at,
                tombstone        = 0
            """,
            (account, gcal_id, display_name, description, timezone,
             config.INGESTER_VERSION),
        )
        con.commit()
        row = con.execute(
            "SELECT id, google_account, gcal_calendar_id, display_name, timezone "
            "FROM calendars WHERE is_default = 1 LIMIT 1"
        ).fetchone()

    print(
        f"OK: default calendar seeded — id={row['id']} account={row['google_account']} "
        f"calendar_id={row['gcal_calendar_id']} display={row['display_name']!r} "
        f"tz={row['timezone']}"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description="One-time Google OAuth + calendars seed for the sidecar."
    )
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="[%(levelname)s] %(message)s",
    )

    print(f"Using client secrets: {config.GCAL_CLIENT_SECRETS_PATH}")
    print(f"Token will be written to: {config.GCAL_TOKEN_PATH}")
    print("Opening browser for consent…")
    creds = _run_consent()
    _persist_token(creds)
    _seed_calendars(creds)
    print("Done.")


if __name__ == "__main__":
    main()
