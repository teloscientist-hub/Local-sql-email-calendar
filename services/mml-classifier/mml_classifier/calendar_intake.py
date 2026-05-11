"""Google Calendar → warehouse intake.

Mirrors the mailspring_intake.py pattern: dry-run by default, APFS-clone
backup before any --commit, idempotent on (calendar_pk, gcal_event_id).
Uses Google's syncToken-based incremental sync; falls back to a full
backfill on first run or when the stored token has expired.

CLI:
    python -m mml_classifier.calendar_intake                  # dry-run
    python -m mml_classifier.calendar_intake --commit
    python -m mml_classifier.calendar_intake --commit --full-backfill
    python -m mml_classifier.calendar_intake --commit --limit 50
    python -m mml_classifier.calendar_intake --commit --calendar primary

What it does:
    1. Loads OAuth credentials (gcal_oauth.get_credentials()).
    2. Resolves target calendars from the warehouse (defaults to all
       non-tombstone rows; --calendar filters by gcal_calendar_id).
    3. For each calendar, pages through events.list. Uses syncToken when
       available, otherwise full backfill (singleEvents=true, timeMin=epoch).
    4. Normalizes each event (calendar_normalize.normalize_event).
    5. For each normalized event:
         - new gcal_event_id → INSERT events + event_attendees, write
           event_changes 'insert'.
         - existing event with etag change → UPDATE events, replace
           event_attendees rows, compute diff + write event_changes
           'update' (or 'cancel' if status flipped to 'cancelled').
         - existing event with same etag → skip.
       Identity: each attendee email is upserted into contact_email_map →
       contact_entities (auto-creating persons for unknown addresses).
    6. Persists nextSyncToken into calendars.sync_token on commit.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import shutil
import sqlite3
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

from . import config
from .calendar_history import classify_change_kind, compute_event_diff
from .calendar_normalize import NormalizedEvent, normalize_event

log = logging.getLogger(__name__)

INTAKE_VERSION = "calendar-intake-v0.1.0"

# Backfill window. Defaults match the events_active view: 5 years back,
# 1 year forward. Google's singleEvents=true expands recurring events
# into every occurrence in the window, so an unbounded window would
# return decades of birthday/anniversary expansions.
DEFAULT_YEARS_BACK = 5
DEFAULT_YEARS_FORWARD = 1


def _default_timemin() -> str:
    return (
        dt.datetime.now(tz=dt.timezone.utc)
        - dt.timedelta(days=365 * DEFAULT_YEARS_BACK)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")


def _default_timemax() -> str:
    return (
        dt.datetime.now(tz=dt.timezone.utc)
        + dt.timedelta(days=365 * DEFAULT_YEARS_FORWARD)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Connection helpers


@contextmanager
def _warehouse(*, mode: str) -> Iterator[sqlite3.Connection]:
    uri = f"file:{quote(str(config.WAREHOUSE_DB))}?mode={mode}"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON;")
    try:
        yield con
    finally:
        con.close()


# ---------------------------------------------------------------------------
# Data shapes


@dataclass
class EventAction:
    """One pending write for an event. Built during plan, applied during commit."""
    kind: str                                # 'insert' | 'update' | 'cancel' | 'skip'
    normalized: NormalizedEvent
    raw_event: dict[str, Any]                # full Google payload (snapshot_json source)
    existing_event_id: int | None            # warehouse PK if update/cancel, else None
    existing_etag: str | None                # for event_changes.etag_before
    diff: dict[str, Any] = field(default_factory=dict)


@dataclass
class IntakePlan:
    calendar_pk: int
    gcal_calendar_id: str
    mode: str                                # 'full-backfill' | 'incremental'
    actions: list[EventAction] = field(default_factory=list)
    next_sync_token: str | None = None
    new_attendee_emails: dict[str, str] = field(default_factory=dict)  # email → display_name
    sync_token_expired: bool = False


@dataclass
class IntakeStats:
    events_inserted: int = 0
    events_updated: int = 0
    events_cancelled: int = 0
    events_skipped: int = 0
    attendees_inserted: int = 0
    attendees_deleted: int = 0
    contacts_inserted: int = 0
    contact_email_map_inserted: int = 0
    changes_inserted: int = 0


# ---------------------------------------------------------------------------
# Google API event iteration
#
# Kept thin so tests can substitute via the `events_source` arg on build_plan.


def fetch_events(
    service: Any,
    *,
    calendar_id: str,
    sync_token: str | None,
    full_backfill: bool,
    limit: int | None = None,
    time_min: str | None = None,
    time_max: str | None = None,
) -> tuple[Iterator[dict[str, Any]], dict[str, Any]]:
    """Iterate events.list pages. Returns (event_iterator, meta).

    meta = {"next_sync_token": str|None, "sync_token_expired": bool, "total": int}

    If sync_token is provided and not expired, uses it for incremental sync.
    Otherwise (or if full_backfill=True), does a singleEvents-expanded backfill
    bounded by [time_min, time_max). Both default to a 5y-back / 1y-forward
    window (see _default_timemin / _default_timemax).
    """
    from googleapiclient.errors import HttpError  # local import to keep import cheap

    meta = {"next_sync_token": None, "sync_token_expired": False, "total": 0}
    time_min = time_min or _default_timemin()
    time_max = time_max or _default_timemax()

    def _iter() -> Iterator[dict[str, Any]]:
        page_token: str | None = None
        emitted = 0
        use_sync_token = bool(sync_token) and not full_backfill
        while True:
            kwargs: dict[str, Any] = {
                "calendarId": calendar_id,
                "showDeleted": True,
                "maxResults": 2500,
                "pageToken": page_token,
            }
            if use_sync_token:
                kwargs["syncToken"] = sync_token
            else:
                kwargs["singleEvents"] = True
                kwargs["timeMin"] = time_min
                kwargs["timeMax"] = time_max
                kwargs["orderBy"] = "startTime"

            try:
                resp = service.events().list(**kwargs).execute()
            except HttpError as e:
                if e.resp.status == 410 and use_sync_token:
                    # Sync token expired → fall through to full backfill on
                    # next call. Signal via meta.
                    meta["sync_token_expired"] = True
                    log.warning("syncToken expired for calendar=%s; caller should retry with full_backfill",
                                calendar_id)
                    return
                raise

            for item in resp.get("items", []):
                meta["total"] = meta["total"] + 1
                emitted += 1
                yield item
                if limit and emitted >= limit:
                    meta["next_sync_token"] = resp.get("nextSyncToken")
                    return

            page_token = resp.get("nextPageToken")
            if not page_token:
                meta["next_sync_token"] = resp.get("nextSyncToken")
                return

    return _iter(), meta


# ---------------------------------------------------------------------------
# Plan building


def _fetch_existing_event(
    con: sqlite3.Connection, calendar_pk: int, gcal_event_id: str
) -> sqlite3.Row | None:
    return con.execute(
        "SELECT * FROM events WHERE calendar_pk = ? AND gcal_event_id = ?",
        (calendar_pk, gcal_event_id),
    ).fetchone()


def _fetch_existing_attendees(
    con: sqlite3.Connection, event_pk: int
) -> list[dict[str, Any]]:
    rows = con.execute(
        "SELECT email, response_status FROM event_attendees WHERE event_id = ?",
        (event_pk,),
    ).fetchall()
    return [dict(r) for r in rows]


def _existing_emails(con: sqlite3.Connection) -> set[str]:
    rows = con.execute("SELECT email FROM contact_email_map").fetchall()
    return {r["email"] for r in rows}


def build_plan(
    *,
    calendar_pk: int,
    gcal_calendar_id: str,
    events_iter: Iterator[dict[str, Any]],
    meta: dict[str, Any],
    full_backfill: bool,
) -> IntakePlan:
    """Walk an events iterator, classify each, and produce a write plan."""
    plan = IntakePlan(
        calendar_pk=calendar_pk,
        gcal_calendar_id=gcal_calendar_id,
        mode="full-backfill" if full_backfill else "incremental",
    )

    with _warehouse(mode="ro") as wh:
        known_emails = _existing_emails(wh)

        for raw in events_iter:
            normalized = normalize_event(raw)
            if normalized is None:
                continue

            existing = _fetch_existing_event(wh, calendar_pk, normalized.gcal_event_id)

            if existing is None:
                kind = "insert"
                diff: dict[str, Any] = {}
                existing_etag: str | None = None
                existing_id: int | None = None
            else:
                existing_id = int(existing["id"])
                existing_etag = existing["etag"]
                if existing_etag and normalized.etag and existing_etag == normalized.etag:
                    plan.actions.append(EventAction(
                        kind="skip", normalized=normalized, raw_event=raw,
                        existing_event_id=existing_id, existing_etag=existing_etag,
                    ))
                    continue
                old_attendees = _fetch_existing_attendees(wh, existing_id)
                diff = compute_event_diff(dict(existing), normalized, old_attendees)
                kind = classify_change_kind(dict(existing), normalized)
                if not diff and existing_etag == normalized.etag:
                    plan.actions.append(EventAction(
                        kind="skip", normalized=normalized, raw_event=raw,
                        existing_event_id=existing_id, existing_etag=existing_etag,
                    ))
                    continue

            plan.actions.append(EventAction(
                kind=kind, normalized=normalized, raw_event=raw,
                existing_event_id=existing_id, existing_etag=existing_etag,
                diff=diff,
            ))

            # Track new attendee + organizer emails for the dry-run summary.
            email_pool: list[tuple[str, str | None]] = [
                (a.email, a.display_name) for a in normalized.attendees
            ]
            if normalized.organizer_email:
                email_pool.append((normalized.organizer_email, None))
            for email, name in email_pool:
                if email and email not in known_emails:
                    plan.new_attendee_emails.setdefault(email, name or email)
                    known_emails.add(email)

    plan.next_sync_token = meta.get("next_sync_token")
    plan.sync_token_expired = bool(meta.get("sync_token_expired"))
    return plan


# ---------------------------------------------------------------------------
# Commit


def _ensure_contact(
    con: sqlite3.Connection,
    email_lower: str,
    display_name: str | None,
    now_iso: str,
) -> tuple[int, bool, bool]:
    """Mirrors mailspring_intake._ensure_contact. Returns (entity_id, created_entity, created_map)."""
    row = con.execute(
        "SELECT contact_entity_id FROM contact_email_map WHERE email = ?",
        (email_lower,),
    ).fetchone()
    if row:
        return int(row["contact_entity_id"]), False, False

    canonical_name = (display_name or email_lower).strip() or email_lower
    cur = con.execute(
        """
        INSERT INTO contact_entities (canonical_name, canonical_email, ingester_version,
                                      created_at, updated_at, is_me, is_list_addr, tombstone)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0)
        """,
        (canonical_name, email_lower, INTAKE_VERSION, now_iso, now_iso),
    )
    entity_id = int(cur.lastrowid)
    con.execute(
        """
        INSERT INTO contact_email_map (email, contact_entity_id, primary_for_contact,
                                       first_seen_at, last_seen_at, tombstone)
        VALUES (?, ?, 1, ?, ?, 0)
        """,
        (email_lower, entity_id, now_iso, now_iso),
    )
    return entity_id, True, True


def _me_addresses(con: sqlite3.Connection) -> set[str]:
    rows = con.execute("SELECT email FROM me_addresses").fetchall()
    return {r["email"] for r in rows if r["email"]}


_EVENT_COLUMNS_FOR_UPDATE = (
    "ical_uid", "recurring_event_id", "title", "description", "location",
    "start_iso", "end_iso", "timezone", "all_day", "status",
    "organizer_email", "organizer_self", "visibility", "transparency",
    "etag", "html_link", "hangout_link", "created_at_google",
    "updated_at_google",
)


def commit_plan(plan: IntakePlan) -> IntakeStats:
    stats = IntakeStats()
    now_iso = dt.datetime.now(tz=dt.timezone.utc).isoformat(timespec="seconds")

    with _warehouse(mode="rw") as con:
        me_addrs = _me_addresses(con)
        con.execute("BEGIN")
        try:
            for action in plan.actions:
                if action.kind == "skip":
                    stats.events_skipped += 1
                    continue

                n = action.normalized

                if action.kind == "insert":
                    cur = con.execute(
                        """
                        INSERT INTO events
                            (calendar_pk, gcal_event_id, ical_uid, recurring_event_id,
                             title, description, location, start_iso, end_iso, timezone,
                             all_day, status, organizer_email, organizer_self,
                             visibility, transparency, etag, html_link, hangout_link,
                             created_at_google, updated_at_google,
                             source, llm_drafted, plugin_version, sidecar_version,
                             first_seen_at, last_seen_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                'gcal-sync', 0, NULL, ?, ?, ?)
                        """,
                        (
                            plan.calendar_pk, n.gcal_event_id, n.ical_uid, n.recurring_event_id,
                            n.title, n.description, n.location, n.start_iso, n.end_iso, n.timezone,
                            n.all_day, n.status, n.organizer_email, n.organizer_self,
                            n.visibility, n.transparency, n.etag, n.html_link, n.hangout_link,
                            n.created_at_google, n.updated_at_google,
                            config.INGESTER_VERSION, now_iso, now_iso,
                        ),
                    )
                    event_pk = int(cur.lastrowid)
                    stats.events_inserted += 1
                else:
                    # update / cancel
                    event_pk = action.existing_event_id  # type: ignore[assignment]
                    assignments = ", ".join(f"{c} = ?" for c in _EVENT_COLUMNS_FOR_UPDATE)
                    values = tuple(getattr(n, c) for c in _EVENT_COLUMNS_FOR_UPDATE)
                    con.execute(
                        f"UPDATE events SET {assignments}, last_seen_at = ? WHERE id = ?",
                        (*values, now_iso, event_pk),
                    )
                    # Replace attendees wholesale — simpler and correct.
                    deleted = con.execute(
                        "DELETE FROM event_attendees WHERE event_id = ?", (event_pk,)
                    ).rowcount
                    stats.attendees_deleted += deleted
                    if action.kind == "cancel":
                        stats.events_cancelled += 1
                    else:
                        stats.events_updated += 1

                # Identity hookup + attendee rows
                for a in n.attendees:
                    _, e_new, m_new = _ensure_contact(con, a.email, a.display_name, now_iso)
                    if e_new:
                        stats.contacts_inserted += 1
                    if m_new:
                        stats.contact_email_map_inserted += 1
                    is_self_flag = a.is_self or (1 if a.email in me_addrs else 0)
                    con.execute(
                        """
                        INSERT INTO event_attendees
                            (event_id, email, display_name, response_status,
                             is_organizer, is_optional, is_self, is_resource)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            event_pk, a.email, a.display_name, a.response_status,
                            a.is_organizer, a.is_optional, is_self_flag, a.is_resource,
                        ),
                    )
                    stats.attendees_inserted += 1

                # Organizer-only identity (if not in attendees list)
                if n.organizer_email and n.organizer_email not in {a.email for a in n.attendees}:
                    _, e_new, m_new = _ensure_contact(con, n.organizer_email, None, now_iso)
                    if e_new:
                        stats.contacts_inserted += 1
                    if m_new:
                        stats.contact_email_map_inserted += 1

                # History row
                diff_json = json.dumps(action.diff) if action.diff else None
                con.execute(
                    """
                    INSERT INTO event_changes
                        (event_id, etag_before, etag_after, change_kind,
                         diff_json, snapshot_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event_pk, action.existing_etag, n.etag, action.kind,
                        diff_json, json.dumps(action.raw_event),
                    ),
                )
                stats.changes_inserted += 1

            # Persist next_sync_token on the calendar row.
            if plan.next_sync_token is not None:
                con.execute(
                    "UPDATE calendars SET sync_token = ?, synced_at = ? WHERE id = ?",
                    (plan.next_sync_token, now_iso, plan.calendar_pk),
                )
            else:
                con.execute(
                    "UPDATE calendars SET synced_at = ? WHERE id = ?",
                    (now_iso, plan.calendar_pk),
                )

            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise

    return stats


# ---------------------------------------------------------------------------
# CLI plumbing


def _resolve_target_calendars(
    *, calendar_filter: str | None
) -> list[sqlite3.Row]:
    with _warehouse(mode="ro") as con:
        if calendar_filter:
            rows = con.execute(
                "SELECT * FROM calendars WHERE COALESCE(tombstone,0)=0 AND gcal_calendar_id = ?",
                (calendar_filter,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM calendars WHERE COALESCE(tombstone,0)=0 ORDER BY id"
            ).fetchall()
        return list(rows)


def _backup_warehouse() -> Path:
    src = config.WAREHOUSE_DB
    iso = dt.datetime.now(tz=dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    dst = src.with_suffix(src.suffix + f".pre-calendar-intake-{iso}")
    log.info("backing up warehouse → %s", dst)
    try:
        os.system(f'cp -c "{src}" "{dst}"')
    except Exception:  # noqa: BLE001
        shutil.copy2(src, dst)
    if not dst.exists():
        shutil.copy2(src, dst)
    return dst


def _print_plan_summary(plan: IntakePlan) -> None:
    insert_n = sum(1 for a in plan.actions if a.kind == "insert")
    update_n = sum(1 for a in plan.actions if a.kind == "update")
    cancel_n = sum(1 for a in plan.actions if a.kind == "cancel")
    skip_n = sum(1 for a in plan.actions if a.kind == "skip")

    print()
    print(f"--- calendar: {plan.gcal_calendar_id}  (mode: {plan.mode}) ---")
    print(f"  would insert: {insert_n:,}")
    print(f"  would update: {update_n:,}")
    print(f"  would cancel: {cancel_n:,}")
    print(f"  unchanged:    {skip_n:,}")
    print(f"  new attendee emails (would auto-create contacts): {len(plan.new_attendee_emails):,}")
    if plan.sync_token_expired:
        print("  WARN: sync token expired; will fall back to full backfill on commit")
    if plan.next_sync_token:
        print(f"  next sync token: {plan.next_sync_token[:16]}…")
    samples = [a for a in plan.actions if a.kind != "skip"][:5]
    if samples:
        print("  sample of pending changes (first 5):")
        for a in samples:
            n = a.normalized
            print(f"    [{a.kind:6s}] {n.start_iso or '?':25s}  {(n.title or '<no-title>')[:60]}")
            print(f"             gcal_event_id={n.gcal_event_id}")
    sample_emails = list(plan.new_attendee_emails.items())[:10]
    if sample_emails:
        print("  sample new attendee emails (max 10):")
        for e, name in sample_emails:
            print(f"    {e}  ({name})")


def _run_one_calendar(
    *,
    service: Any,
    calendar_row: sqlite3.Row,
    full_backfill: bool,
    limit: int | None,
    time_min: str | None = None,
    time_max: str | None = None,
) -> IntakePlan:
    sync_token = calendar_row["sync_token"]
    iterator, meta = fetch_events(
        service,
        calendar_id=calendar_row["gcal_calendar_id"],
        sync_token=sync_token,
        full_backfill=full_backfill,
        limit=limit,
        time_min=time_min,
        time_max=time_max,
    )
    plan = build_plan(
        calendar_pk=int(calendar_row["id"]),
        gcal_calendar_id=calendar_row["gcal_calendar_id"],
        events_iter=iterator,
        meta=meta,
        full_backfill=full_backfill,
    )
    if plan.sync_token_expired and not full_backfill:
        # Auto-retry without sync token.
        log.info("retrying calendar=%s with full backfill (sync token expired)",
                 calendar_row["gcal_calendar_id"])
        iterator, meta = fetch_events(
            service,
            calendar_id=calendar_row["gcal_calendar_id"],
            sync_token=None,
            full_backfill=True,
            limit=limit,
            time_min=time_min,
            time_max=time_max,
        )
        plan = build_plan(
            calendar_pk=int(calendar_row["id"]),
            gcal_calendar_id=calendar_row["gcal_calendar_id"],
            events_iter=iterator,
            meta=meta,
            full_backfill=True,
        )
    return plan


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Google Calendar → warehouse intake (dry-run by default)."
    )
    ap.add_argument("--commit", action="store_true",
                    help="Actually write to the warehouse.")
    ap.add_argument("--full-backfill", action="store_true",
                    help="Ignore stored sync_token; re-page all events.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap events per calendar (for testing).")
    ap.add_argument("--calendar", default=None,
                    help="Filter to one gcal_calendar_id (default: all non-tombstone).")
    ap.add_argument("--timemin", default=None,
                    help=f"Override backfill timeMin (RFC3339). "
                         f"Default: now - {DEFAULT_YEARS_BACK}y.")
    ap.add_argument("--timemax", default=None,
                    help=f"Override backfill timeMax (RFC3339). "
                         f"Default: now + {DEFAULT_YEARS_FORWARD}y.")
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    # Resolve calendars first — fail fast if there are none.
    targets = _resolve_target_calendars(calendar_filter=args.calendar)
    if not targets:
        if args.calendar:
            print(f"no calendar matching gcal_calendar_id={args.calendar!r}", file=sys.stderr)
        else:
            print("no calendars seeded in warehouse. "
                  "Run: python -m mml_classifier.gcal_oauth_setup", file=sys.stderr)
        return 2

    # Build the Google Calendar service.
    try:
        from . import gcal_oauth
        creds = gcal_oauth.get_credentials()
    except Exception as e:  # noqa: BLE001
        print(f"gcal auth failed: {e}", file=sys.stderr)
        return 2

    from googleapiclient.discovery import build
    service = build("calendar", "v3", credentials=creds, cache_discovery=False)

    effective_timemin = args.timemin or _default_timemin()
    effective_timemax = args.timemax or _default_timemax()

    print(f"=== Google Calendar → warehouse intake — "
          f"{'COMMIT' if args.commit else 'DRY RUN'} ===")
    print(f"target calendars: {len(targets)}  "
          f"(full_backfill={args.full_backfill}, limit={args.limit})")
    print(f"backfill window:  {effective_timemin}  →  {effective_timemax}")

    plans: list[IntakePlan] = []
    for cal in targets:
        try:
            plan = _run_one_calendar(
                service=service,
                calendar_row=cal,
                full_backfill=args.full_backfill,
                limit=args.limit,
                time_min=effective_timemin,
                time_max=effective_timemax,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("plan build failed for calendar=%s", cal["gcal_calendar_id"])
            print(f"FAIL: calendar={cal['gcal_calendar_id']} — {e}", file=sys.stderr)
            return 2
        plans.append(plan)
        _print_plan_summary(plan)

    if not args.commit:
        print()
        print("Run again with --commit to actually write. "
              "A backup of warehouse.sqlite will be made at "
              "<warehouse>.pre-calendar-intake-<ISO> before any writes.")
        return 0

    if not any(a.kind != "skip" for p in plans for a in p.actions):
        print("\nnothing to write; all events up to date.")
        return 0

    backup = _backup_warehouse()
    print(f"\nbackup written to: {backup}\n")

    totals = IntakeStats()
    for plan in plans:
        stats = commit_plan(plan)
        totals.events_inserted        += stats.events_inserted
        totals.events_updated         += stats.events_updated
        totals.events_cancelled       += stats.events_cancelled
        totals.events_skipped         += stats.events_skipped
        totals.attendees_inserted     += stats.attendees_inserted
        totals.attendees_deleted      += stats.attendees_deleted
        totals.contacts_inserted      += stats.contacts_inserted
        totals.contact_email_map_inserted += stats.contact_email_map_inserted
        totals.changes_inserted       += stats.changes_inserted
        print(f"--- calendar: {plan.gcal_calendar_id} — committed ---")
        print(f"  events inserted/updated/cancelled/skipped: "
              f"{stats.events_inserted}/{stats.events_updated}/"
              f"{stats.events_cancelled}/{stats.events_skipped}")
        print(f"  attendees inserted/deleted: "
              f"{stats.attendees_inserted}/{stats.attendees_deleted}")
        print(f"  new contacts / email_map rows: "
              f"{stats.contacts_inserted}/{stats.contact_email_map_inserted}")
        print(f"  event_changes rows: {stats.changes_inserted}")

    print()
    print("=== TOTALS ===")
    print(f"  events inserted: {totals.events_inserted:,}")
    print(f"  events updated:  {totals.events_updated:,}")
    print(f"  events cancelled:{totals.events_cancelled:,}")
    print(f"  events skipped:  {totals.events_skipped:,}")
    print(f"  attendees:       +{totals.attendees_inserted:,} / "
          f"-{totals.attendees_deleted:,}")
    print(f"  new contacts:    {totals.contacts_inserted:,}")
    print(f"  event_changes:   {totals.changes_inserted:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
