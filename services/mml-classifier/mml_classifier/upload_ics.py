"""Upload an .ics file's VEVENTs to a chosen Google Calendar.

Reuses gcal_client (which handles OAuth via gcal_oauth + caches a single
service binding) to list calendars and insert events. Parses ICS via the
icalendar library to handle line folding, escaping, and TZID correctly.

Usage:
    .venv/bin/python -m mml_classifier.upload_ics --list
        Lists writable calendars (owner/writer access) and exits.

    .venv/bin/python -m mml_classifier.upload_ics \\
        --ics /path/to/file.ics --calendar "Calendar Name" --yes
        Non-interactive: uploads every VEVENT to the named calendar.

    .venv/bin/python -m mml_classifier.upload_ics --ics PATH --dry-run
        Parses the file and prints sample events. No API calls.

Notes
-----
- Calendar name match is case-insensitive on the calendar's `summary` field.
- Events are created via events.insert (one POST per VEVENT). Re-running on
  the same file creates duplicates.
- Every event's DESCRIPTION, LOCATION, RRULE (if present), and TZID are
  preserved. UID is dropped (gcal mints its own event IDs).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from icalendar import Calendar

from . import config, gcal_client


def _writable_calendars() -> list[dict[str, Any]]:
    return [
        c for c in gcal_client.list_calendars()
        if c.get("accessRole") in ("owner", "writer")
    ]


def _find_calendar(cals: list[dict[str, Any]], name: str) -> dict[str, Any]:
    lname = name.lower()
    matches = [c for c in cals if (c.get("summary") or "").lower() == lname]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        names = ", ".join(repr(c.get("summary")) for c in cals)
        sys.exit(f"no writable calendar named {name!r}. options: {names}")
    sys.exit(f"multiple writable calendars named {name!r}; disambiguate by ID")


def _to_api_dt(field) -> dict[str, str]:
    dt = field.dt
    if hasattr(dt, "hour"):
        tzid = (field.params or {}).get("TZID")
        if tzid:
            return {
                "dateTime": dt.replace(microsecond=0, tzinfo=None).isoformat(),
                "timeZone": str(tzid),
            }
        if dt.tzinfo is not None:
            return {"dateTime": dt.replace(microsecond=0).isoformat()}
        return {
            "dateTime": dt.replace(microsecond=0).isoformat(),
            "timeZone": config.GCAL_TIMEZONE,
        }
    return {"date": dt.isoformat()}


def _vevent_to_body(ve) -> dict[str, Any]:
    body: dict[str, Any] = {"summary": str(ve.get("SUMMARY") or "")}
    desc = ve.get("DESCRIPTION")
    if desc:
        body["description"] = str(desc)
    loc = ve.get("LOCATION")
    if loc:
        body["location"] = str(loc)

    body["start"] = _to_api_dt(ve.get("DTSTART"))
    dtend = ve.get("DTEND")
    body["end"] = _to_api_dt(dtend) if dtend is not None else body["start"]

    rrule = ve.get("RRULE")
    if rrule is not None:
        rrule_str = (
            rrule.to_ical().decode("utf-8")
            if hasattr(rrule, "to_ical")
            else str(rrule)
        )
        body["recurrence"] = [f"RRULE:{rrule_str}"]
    return body


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ics", type=Path, help="path to .ics file to upload")
    ap.add_argument("--calendar", help="destination calendar name (summary field)")
    ap.add_argument("--list", action="store_true", help="list writable calendars and exit")
    ap.add_argument("--dry-run", action="store_true", help="parse but skip API insert")
    ap.add_argument("--yes", action="store_true", help="skip the pre-insert confirmation prompt")
    args = ap.parse_args()

    cals = _writable_calendars()

    if args.list:
        for c in cals:
            marker = " [primary]" if c.get("primary") else ""
            print(f"  {c.get('summary', '(no name)')}{marker}  ({c['accessRole']})  id={c['id']}")
        return 0

    if not args.ics:
        ap.error("--ics is required (unless --list)")
    if not args.ics.exists():
        sys.exit(f"file not found: {args.ics}")

    raw = args.ics.read_bytes()
    ical = Calendar.from_ical(raw)
    events = list(ical.walk("VEVENT"))
    print(f"parsed {len(events)} events from {args.ics.name}")

    if not args.calendar:
        ap.error("--calendar is required for upload (use --list to see options)")
    cal = _find_calendar(cals, args.calendar)
    print(f"target: {cal.get('summary')!r} (id={cal['id']})")

    if args.dry_run:
        print("\n--dry-run: not inserting. sample bodies:")
        for i, ve in enumerate(events[:3], 1):
            body = _vevent_to_body(ve)
            print(
                f"  {i}. summary={body.get('summary')!r}  "
                f"start={body.get('start')}  end={body.get('end')}  "
                f"recurrence={body.get('recurrence')}"
            )
        if len(events) > 3:
            print(f"  ... +{len(events) - 3} more")
        return 0

    if not args.yes:
        ans = input(f"create {len(events)} events on {cal.get('summary')!r}? (y/N) ").strip().lower()
        if ans != "y":
            sys.exit("aborted")

    created = 0
    failed: list[tuple[int, str, str]] = []
    for i, ve in enumerate(events, 1):
        body = _vevent_to_body(ve)
        try:
            gcal_client.insert_event(cal["id"], body)
            created += 1
            if created % 10 == 0 or created == len(events):
                print(f"  [{created}/{len(events)}] created")
        except Exception as e:
            failed.append((i, str(body.get("summary")), str(e)))
            print(f"  ! event {i} {body.get('summary')!r} failed: {e}", file=sys.stderr)

    print(f"\ndone: {created} created, {len(failed)} failed")
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
