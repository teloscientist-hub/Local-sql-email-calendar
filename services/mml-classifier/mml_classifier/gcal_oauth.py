"""Google OAuth2 credentials handling for the sidecar.

The sidecar uses a single Google account at MVP (Phase 5). One-time consent
runs through `python -m mml_classifier.gcal_oauth_setup`, which pops a
browser, completes the InstalledAppFlow, and writes a refresh-tokened
Credentials JSON to config.GCAL_TOKEN_PATH.

`get_credentials()` is the runtime entry point — loads the token, refreshes
if expired, persists the refreshed token back, and returns a Credentials
ready to pass to googleapiclient.discovery.build().

Raises GcalAuthError when the token is missing, can't be refreshed, or is
invalid. Callers (event_creator.create_event) surface the error string back
to the plugin so the overlay can show "gcal auth required — run setup".
"""

from __future__ import annotations

import logging
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

from . import config

log = logging.getLogger(__name__)


class GcalAuthError(RuntimeError):
    """OAuth flow problem the user can act on (missing/expired token, etc.)."""


def get_credentials() -> Credentials:
    """Load and refresh OAuth credentials.

    Side effect: persists refreshed credentials back to GCAL_TOKEN_PATH
    when a refresh occurs, so the next call doesn't re-refresh.
    """
    token_path = config.GCAL_TOKEN_PATH
    if not token_path.exists():
        raise GcalAuthError(
            f"gcal auth required: token file not found at {token_path}. "
            "Run: python -m mml_classifier.gcal_oauth_setup"
        )

    try:
        creds = Credentials.from_authorized_user_file(
            str(token_path), scopes=list(config.GCAL_SCOPES)
        )
    except Exception as e:  # noqa: BLE001
        raise GcalAuthError(
            f"gcal token at {token_path} is unreadable or malformed: {e}. "
            "Re-run: python -m mml_classifier.gcal_oauth_setup"
        ) from e

    if creds.valid:
        return creds

    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except Exception as e:  # noqa: BLE001
            raise GcalAuthError(
                f"gcal token refresh failed: {e}. "
                "Re-run: python -m mml_classifier.gcal_oauth_setup"
            ) from e
        _persist(creds)
        return creds

    raise GcalAuthError(
        "gcal token is invalid and cannot be refreshed (no refresh_token). "
        "Re-run: python -m mml_classifier.gcal_oauth_setup"
    )


def _persist(creds: Credentials) -> None:
    """Write the credentials JSON back to GCAL_TOKEN_PATH atomically."""
    payload = creds.to_json()
    tmp = config.GCAL_TOKEN_PATH.with_suffix(config.GCAL_TOKEN_PATH.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(config.GCAL_TOKEN_PATH)
    log.info("gcal token refreshed and persisted to %s", config.GCAL_TOKEN_PATH)


def credentials_status() -> dict[str, Any]:
    """Cheap status probe used by /healthz. Never raises."""
    out: dict[str, Any] = {
        "token_path": str(config.GCAL_TOKEN_PATH),
        "token_present": config.GCAL_TOKEN_PATH.exists(),
        "valid": False,
        "expired": None,
        "scopes": None,
        "error": None,
    }
    if not out["token_present"]:
        return out
    try:
        creds = Credentials.from_authorized_user_file(
            str(config.GCAL_TOKEN_PATH), scopes=list(config.GCAL_SCOPES)
        )
        out["valid"] = bool(creds.valid)
        out["expired"] = bool(creds.expired)
        out["scopes"] = list(creds.scopes or [])
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
    return out
