"""Google Contacts intake — syncs People API → warehouse.

Usage:
    # Dry-run (default): prints what would change, no writes
    python -m mml_classifier.contacts_intake

    # Commit the changes
    python -m mml_classifier.contacts_intake --commit

    # Full re-sync (ignore stored sync_token, re-fetch everything)
    python -m mml_classifier.contacts_intake --full --commit

    # Test with a small slice
    python -m mml_classifier.contacts_intake --limit 50

Each contact from Google is resolved to a contact_entities row by matching its
email addresses against contact_email_map.  Three outcomes per contact:

  CLAIM  — exactly one contact_entity already owns one of these emails
  NEW    — no match; a new contact_entity row will be created
  MERGE  — two or more distinct contact_entities own different emails from this
            contact; the one with the most email_map entries wins, the others
            are tombstoned and their email_map entries re-pointed to the winner

Run without --commit first: the dry-run report shows exactly which merges
would happen before any database writes occur.
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from . import config, db
from .gcal_oauth import GcalAuthError, get_credentials

log = logging.getLogger(__name__)

CONTACTS_INTAKE_VERSION = "contacts_intake@0.1.0"

# People API fields to request
PERSON_FIELDS = ",".join([
    "names",
    "emailAddresses",
    "phoneNumbers",
    "addresses",
    "organizations",
    "birthdays",
    "biographies",
    "memberships",
    "nicknames",
    "photos",
    "metadata",
])

PAGE_SIZE = 1000  # max allowed by People API


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------

@dataclass
class ParsedContact:
    resource_name: str
    etag: str
    display_name: str
    given_name: str | None
    family_name: str | None
    middle_name: str | None
    name_prefix: str | None
    name_suffix: str | None
    nickname: str | None
    organization: str | None
    title: str | None
    department: str | None
    birthday_iso: str | None
    notes: str | None
    starred: bool
    photo_url: str | None
    emails: list[dict]       # [{"addr": str, "label": str, "primary": bool}]
    phones: list[dict]       # [{"normalized": str, "display": str, "label": str, "primary": bool}]
    addresses: list[dict]    # [{"label": str, "street": str, ...}]
    group_resources: list[str]  # ["contactGroups/abc123", ...]


@dataclass
class SyncPlan:
    claims: list[tuple[ParsedContact, int]] = field(default_factory=list)   # (contact, entity_id)
    new: list[ParsedContact] = field(default_factory=list)
    merges: list[tuple[ParsedContact, list[int]]] = field(default_factory=list)  # (contact, entity_ids)
    skipped_no_email: list[ParsedContact] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_phone(raw: str) -> str:
    return re.sub(r"\D", "", raw)


def _parse_birthday(birthday: dict) -> str | None:
    d = birthday.get("date", {})
    y = d.get("year") or 0
    m = d.get("month") or 0
    day = d.get("day") or 0
    if m and day:
        if y:
            return f"{y:04d}-{m:02d}-{day:02d}"
        return f"----{m:02d}-{day:02d}"
    return None


def _parse_contact(person: dict) -> ParsedContact:
    resource_name = person.get("resourceName", "")
    etag = person.get("etag", "")

    # Names
    names = person.get("names", [])
    primary_name = next((n for n in names if n.get("metadata", {}).get("primary")), names[0] if names else {})
    display_name = primary_name.get("displayName") or resource_name
    given_name = primary_name.get("givenName")
    family_name = primary_name.get("familyName")
    middle_name = primary_name.get("middleName")
    name_prefix = primary_name.get("honorificPrefix")
    name_suffix = primary_name.get("honorificSuffix")

    # Nickname
    nicknames = person.get("nicknames", [])
    nickname = nicknames[0].get("value") if nicknames else None

    # Organization
    orgs = person.get("organizations", [])
    primary_org = next((o for o in orgs if o.get("metadata", {}).get("primary")), orgs[0] if orgs else {})
    organization = primary_org.get("name")
    title = primary_org.get("title")
    department = primary_org.get("department")

    # Birthday
    birthdays = person.get("birthdays", [])
    birthday_iso = _parse_birthday(birthdays[0]) if birthdays else None

    # Notes/biographies
    bios = person.get("biographies", [])
    notes = bios[0].get("value") if bios else None

    # Starred
    metadata = person.get("metadata", {})
    starred = bool(metadata.get("objectType") == "PERSON")  # fallback; actual starred lives in memberships

    # Photo
    photos = person.get("photos", [])
    primary_photo = next((p for p in photos if p.get("metadata", {}).get("primary") and not p.get("default")), None)
    photo_url = primary_photo.get("url") if primary_photo else None

    # Emails
    emails = []
    for ea in person.get("emailAddresses", []):
        addr = (ea.get("value") or "").strip().lower()
        if not addr:
            continue
        emails.append({
            "addr": addr,
            "label": ea.get("type") or ea.get("formattedType") or "other",
            "primary": bool(ea.get("metadata", {}).get("primary")),
        })
    # Ensure at most one primary
    if emails and not any(e["primary"] for e in emails):
        emails[0]["primary"] = True

    # Phones
    phones = []
    for ph in person.get("phoneNumbers", []):
        raw = (ph.get("value") or "").strip()
        if not raw:
            continue
        normalized = _normalize_phone(raw)
        if not normalized:
            continue
        phones.append({
            "normalized": normalized,
            "display": raw,
            "label": ph.get("type") or ph.get("formattedType") or "other",
            "primary": bool(ph.get("metadata", {}).get("primary")),
        })

    # Addresses
    addresses = []
    for addr in person.get("addresses", []):
        addresses.append({
            "label": addr.get("type") or addr.get("formattedType") or "other",
            "street": addr.get("streetAddress"),
            "city": addr.get("city"),
            "region": addr.get("region"),
            "postal_code": addr.get("postalCode"),
            "country": addr.get("country"),
            "formatted": addr.get("formattedValue"),
        })

    # Group memberships (filter to user-defined contactGroups, skip system ones)
    group_resources = []
    for mem in person.get("memberships", []):
        cg = mem.get("contactGroupMembership", {})
        rn = cg.get("contactGroupResourceName", "")
        if rn and not rn.startswith("contactGroups/myContacts") and not rn.startswith("contactGroups/all") and not rn.startswith("contactGroups/starred"):
            group_resources.append(rn)
        elif rn:
            # Still track system groups by their resource name so we know they're in My Contacts etc.
            group_resources.append(rn)

    return ParsedContact(
        resource_name=resource_name,
        etag=etag,
        display_name=display_name,
        given_name=given_name,
        family_name=family_name,
        middle_name=middle_name,
        name_prefix=name_prefix,
        name_suffix=name_suffix,
        nickname=nickname,
        organization=organization,
        title=title,
        department=department,
        birthday_iso=birthday_iso,
        notes=notes,
        starred=starred,
        photo_url=photo_url,
        emails=emails,
        phones=phones,
        addresses=addresses,
        group_resources=group_resources,
    )


# ---------------------------------------------------------------------------
# API fetching
# ---------------------------------------------------------------------------

def _fetch_group_labels(svc) -> dict[str, str]:
    """Returns {resource_name: group_display_name}."""
    labels: dict[str, str] = {}
    page_token = None
    while True:
        kwargs = {"pageSize": 1000}
        if page_token:
            kwargs["pageToken"] = page_token
        resp = svc.contactGroups().list(**kwargs).execute()
        for g in resp.get("contactGroups", []):
            rn = g.get("resourceName", "")
            name = g.get("name") or g.get("formattedName") or rn
            if rn:
                labels[rn] = name
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return labels


def _fetch_all_contacts(svc, limit: int | None = None, sync_token: str | None = None) -> tuple[list[ParsedContact], str | None]:
    """Page through people.connections.list and return (contacts, next_sync_token)."""
    contacts: list[ParsedContact] = []
    page_token = None
    next_sync_token = None

    while True:
        kwargs: dict = {
            "resourceName": "people/me",
            "pageSize": PAGE_SIZE,
            "personFields": PERSON_FIELDS,
            "requestSyncToken": True,
        }
        if sync_token:
            kwargs["syncToken"] = sync_token
        if page_token:
            kwargs["pageToken"] = page_token

        resp = svc.people().connections().list(**kwargs).execute()
        next_sync_token = resp.get("nextSyncToken") or next_sync_token

        for person in resp.get("connections", []):
            contacts.append(_parse_contact(person))
            if limit and len(contacts) >= limit:
                return contacts, next_sync_token

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return contacts, next_sync_token


# ---------------------------------------------------------------------------
# Resolution logic
# ---------------------------------------------------------------------------

def _build_plan(contacts: list[ParsedContact]) -> SyncPlan:
    plan = SyncPlan()
    with db.read_only() as con:
        for contact in contacts:
            if not contact.emails:
                plan.skipped_no_email.append(contact)
                continue

            addrs = [e["addr"] for e in contact.emails]
            placeholders = ",".join("?" * len(addrs))
            rows = con.execute(
                f"SELECT DISTINCT contact_entity_id FROM contact_email_map "
                f"WHERE email IN ({placeholders}) AND tombstone = 0",
                addrs,
            ).fetchall()
            entity_ids = [r["contact_entity_id"] for r in rows]
            unique_ids = list(dict.fromkeys(entity_ids))  # preserve order, dedupe

            if len(unique_ids) == 0:
                plan.new.append(contact)
            elif len(unique_ids) == 1:
                plan.claims.append((contact, unique_ids[0]))
            else:
                plan.merges.append((contact, unique_ids))

    return plan


# ---------------------------------------------------------------------------
# Dry-run report
# ---------------------------------------------------------------------------

def _print_report(plan: SyncPlan, group_labels: dict[str, str], total: int) -> None:
    print(f"\n{'='*60}")
    print(f"CONTACTS DRY-RUN REPORT  ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')})")
    print(f"{'='*60}")
    print(f"  Total contacts fetched : {total}")
    print(f"  CLAIM  (link to existing person) : {len(plan.claims)}")
    print(f"  NEW    (create new person)       : {len(plan.new)}")
    print(f"  MERGE  (collapse 2+ persons)     : {len(plan.merges)}")
    print(f"  SKIP   (no email address)        : {len(plan.skipped_no_email)}")
    print()

    if plan.merges:
        print(f"--- MERGES ({len(plan.merges)}) ---")
        for contact, ids in plan.merges[:50]:  # cap display at 50
            print(f"  {contact.display_name!r}  emails={[e['addr'] for e in contact.emails]}")
            print(f"    → entity_ids to merge: {ids}")
        if len(plan.merges) > 50:
            print(f"  ... and {len(plan.merges) - 50} more")
        print()

    if plan.new:
        print(f"--- NEW contacts (first 20) ---")
        for contact in plan.new[:20]:
            print(f"  {contact.display_name!r}  emails={[e['addr'] for e in contact.emails]}")
        if len(plan.new) > 20:
            print(f"  ... and {len(plan.new) - 20} more")
        print()

    if plan.skipped_no_email:
        print(f"--- SKIPPED (no email, first 20) ---")
        for contact in plan.skipped_no_email[:20]:
            print(f"  {contact.display_name!r}")
        if len(plan.skipped_no_email) > 20:
            print(f"  ... and {len(plan.skipped_no_email) - 20} more")
        print()

    print("Run with --commit to apply.")


# ---------------------------------------------------------------------------
# Write path
# ---------------------------------------------------------------------------

def _pick_winner(entity_ids: list[int], con) -> tuple[int, list[int]]:
    """Pick the winner entity from a merge set — most email_map entries wins."""
    counts = {}
    for eid in entity_ids:
        row = con.execute(
            "SELECT COUNT(*) AS c FROM contact_email_map WHERE contact_entity_id = ? AND tombstone = 0",
            (eid,),
        ).fetchone()
        counts[eid] = row["c"]
    # Winner has the most emails; ties broken by lowest id (oldest)
    winner = min(entity_ids, key=lambda eid: (-counts[eid], eid))
    losers = [eid for eid in entity_ids if eid != winner]
    return winner, losers


def _apply_merge(winner_id: int, loser_ids: list[int], reason: str, con) -> None:
    now = datetime.now(timezone.utc).isoformat()
    for loser_id in loser_ids:
        # Re-point all email_map entries from loser → winner (avoiding PK conflicts)
        loser_emails = [
            r["email"] for r in con.execute(
                "SELECT email FROM contact_email_map WHERE contact_entity_id = ? AND tombstone = 0",
                (loser_id,),
            ).fetchall()
        ]
        for email in loser_emails:
            existing = con.execute(
                "SELECT email FROM contact_email_map WHERE email = ? AND contact_entity_id = ?",
                (email, winner_id),
            ).fetchone()
            if existing:
                # Winner already has this email — tombstone the duplicate on loser
                con.execute(
                    "UPDATE contact_email_map SET tombstone = 1 WHERE email = ? AND contact_entity_id = ?",
                    (email, loser_id),
                )
            else:
                con.execute(
                    "UPDATE contact_email_map SET contact_entity_id = ? WHERE email = ? AND contact_entity_id = ?",
                    (winner_id, email, loser_id),
                )

        # Merge engagement counts (add loser's send_count to winner, or insert if winner has none)
        loser_eng = con.execute(
            "SELECT send_count, last_sent_at FROM engagement WHERE contact_entity_id = ?",
            (loser_id,),
        ).fetchone()
        if loser_eng:
            winner_eng = con.execute(
                "SELECT contact_entity_id FROM engagement WHERE contact_entity_id = ?",
                (winner_id,),
            ).fetchone()
            if winner_eng:
                con.execute(
                    """UPDATE engagement SET
                        send_count = send_count + ?,
                        last_sent_at = MAX(COALESCE(last_sent_at, ''), COALESCE(?, '')),
                        computed_at = ?
                    WHERE contact_entity_id = ?""",
                    (loser_eng["send_count"], loser_eng["last_sent_at"], now, winner_id),
                )
            else:
                con.execute(
                    "INSERT INTO engagement (contact_entity_id, send_count, last_sent_at, computed_at, source) "
                    "VALUES (?, ?, ?, ?, 'merge')",
                    (winner_id, loser_eng["send_count"], loser_eng["last_sent_at"], now),
                )

        # Tombstone the loser entity
        con.execute(
            "UPDATE contact_entities SET tombstone = 1, updated_at = ? WHERE id = ?",
            (now, loser_id),
        )

        # Audit record
        con.execute(
            "INSERT INTO contact_merges (winner_id, loser_id, reason, merged_at, merged_by) "
            "VALUES (?, ?, ?, ?, ?)",
            (winner_id, loser_id, reason, now, CONTACTS_INTAKE_VERSION),
        )
        log.info("Merged entity %d → %d (%s)", loser_id, winner_id, reason)


def _upsert_contact(contact: ParsedContact, entity_id: int, group_labels: dict[str, str], con) -> None:
    now = datetime.now(timezone.utc).isoformat()

    # Upsert contacts_google
    con.execute(
        """INSERT INTO contacts_google
            (contact_entity_id, google_resource_name, google_etag, given_name,
             family_name, middle_name, name_prefix, name_suffix, nickname,
             display_name, organization, title, department, birthday_iso,
             notes, starred, photo_url, created_at, updated_at, tombstone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(google_resource_name) DO UPDATE SET
             contact_entity_id = excluded.contact_entity_id,
             google_etag       = excluded.google_etag,
             given_name        = excluded.given_name,
             family_name       = excluded.family_name,
             middle_name       = excluded.middle_name,
             name_prefix       = excluded.name_prefix,
             name_suffix       = excluded.name_suffix,
             nickname          = excluded.nickname,
             display_name      = excluded.display_name,
             organization      = excluded.organization,
             title             = excluded.title,
             department        = excluded.department,
             birthday_iso      = excluded.birthday_iso,
             notes             = excluded.notes,
             starred           = excluded.starred,
             photo_url         = excluded.photo_url,
             updated_at        = excluded.updated_at,
             tombstone         = 0""",
        (entity_id, contact.resource_name, contact.etag, contact.given_name,
         contact.family_name, contact.middle_name, contact.name_prefix,
         contact.name_suffix, contact.nickname, contact.display_name,
         contact.organization, contact.title, contact.department,
         contact.birthday_iso, contact.notes, int(contact.starred),
         contact.photo_url, now, now),
    )

    # Update contact_entities canonical_name if it's still a bare email or empty
    row = con.execute(
        "SELECT canonical_name FROM contact_entities WHERE id = ?", (entity_id,)
    ).fetchone()
    if row:
        existing_name = (row["canonical_name"] or "").strip()
        if not existing_name or "@" in existing_name:
            con.execute(
                "UPDATE contact_entities SET canonical_name = ?, updated_at = ? WHERE id = ?",
                (contact.display_name, now, entity_id),
            )
        # Set canonical_email from primary email if missing
        primary_email = next((e["addr"] for e in contact.emails if e["primary"]), None)
        if primary_email:
            con.execute(
                "UPDATE contact_entities SET canonical_email = ? WHERE id = ? AND canonical_email IS NULL",
                (primary_email, entity_id),
            )

    # Upsert all email addresses into contact_email_map
    for em in contact.emails:
        con.execute(
            """INSERT INTO contact_email_map
                (email, contact_entity_id, primary_for_contact, first_seen_at, last_seen_at, tombstone)
               VALUES (?, ?, ?, ?, ?, 0)
               ON CONFLICT(email) DO UPDATE SET
                 contact_entity_id   = excluded.contact_entity_id,
                 primary_for_contact = excluded.primary_for_contact,
                 last_seen_at        = excluded.last_seen_at,
                 tombstone           = 0""",
            (em["addr"], entity_id, int(em["primary"]), now, now),
        )

    # Replace phones (tombstone old, insert new)
    con.execute(
        "UPDATE contact_phones SET tombstone = 1 WHERE contact_entity_id = ?",
        (entity_id,),
    )
    for ph in contact.phones:
        con.execute(
            """INSERT INTO contact_phones
                (contact_entity_id, phone_normalized, phone_display, label, primary_flag, tombstone)
               VALUES (?, ?, ?, ?, ?, 0)
               ON CONFLICT(contact_entity_id, phone_normalized) DO UPDATE SET
                 phone_display = excluded.phone_display,
                 label         = excluded.label,
                 primary_flag  = excluded.primary_flag,
                 tombstone     = 0""",
            (entity_id, ph["normalized"], ph["display"], ph["label"], int(ph["primary"])),
        )

    # Replace addresses (delete and reinsert — no natural unique key)
    con.execute(
        "UPDATE contact_addresses SET tombstone = 1 WHERE contact_entity_id = ?",
        (entity_id,),
    )
    for addr in contact.addresses:
        con.execute(
            """INSERT INTO contact_addresses
                (contact_entity_id, label, street, city, region, postal_code, country, formatted, tombstone)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)""",
            (entity_id, addr["label"], addr["street"], addr["city"],
             addr["region"], addr["postal_code"], addr["country"], addr["formatted"]),
        )

    # Replace group memberships
    con.execute(
        "UPDATE contact_groups SET tombstone = 1 WHERE contact_entity_id = ?",
        (entity_id,),
    )
    for grn in contact.group_resources:
        label = group_labels.get(grn, grn)
        con.execute(
            """INSERT INTO contact_groups
                (contact_entity_id, group_name, google_group_resource, tombstone)
               VALUES (?, ?, ?, 0)
               ON CONFLICT(contact_entity_id, group_name) DO UPDATE SET
                 google_group_resource = excluded.google_group_resource,
                 tombstone             = 0""",
            (entity_id, label, grn),
        )


def _commit_plan(plan: SyncPlan, group_labels: dict[str, str], next_sync_token: str | None) -> None:
    now = datetime.now(timezone.utc).isoformat()
    total_written = 0

    with db.read_write() as con:
        con.execute("BEGIN")

        # 1. Merges first — collapse entities before we reference them
        for contact, entity_ids in plan.merges:
            winner_id, loser_ids = _pick_winner(entity_ids, con)
            reason = f"google_contact:{contact.resource_name} matched {entity_ids}"
            _apply_merge(winner_id, loser_ids, reason, con)
            _upsert_contact(contact, winner_id, group_labels, con)
            total_written += 1

        # 2. Claims — link existing entity to this Google Contact
        for contact, entity_id in plan.claims:
            _upsert_contact(contact, entity_id, group_labels, con)
            total_written += 1

        # 3. New — create entity first, then upsert contact data
        for contact in plan.new:
            primary_email = next((e["addr"] for e in contact.emails), None)
            cur = con.execute(
                """INSERT INTO contact_entities
                    (canonical_name, canonical_email, is_mark, is_list_addr, created_at, updated_at, ingester_version, tombstone)
                   VALUES (?, ?, 0, 0, ?, ?, ?, 0)""",
                (contact.display_name, primary_email, now, now, CONTACTS_INTAKE_VERSION),
            )
            entity_id = cur.lastrowid
            _upsert_contact(contact, entity_id, group_labels, con)
            total_written += 1

        # 4. Save sync token
        if next_sync_token:
            con.execute(
                """INSERT INTO contacts_sync_state (id, sync_token, last_synced_at, contact_count)
                   VALUES (1, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     sync_token     = excluded.sync_token,
                     last_synced_at = excluded.last_synced_at,
                     contact_count  = excluded.contact_count""",
                (next_sync_token, now, total_written),
            )

        con.commit()

    print(f"\nCommitted {total_written} contacts.")
    print(f"  {len(plan.merges)} merges, {len(plan.claims)} claims, {len(plan.new)} new.")
    if next_sync_token:
        print("  sync_token saved — next run will only fetch changes.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Sync Google Contacts → warehouse.")
    ap.add_argument("--commit", action="store_true", help="Write changes (default is dry-run).")
    ap.add_argument("--full", action="store_true", help="Ignore stored sync_token; re-fetch all.")
    ap.add_argument("--limit", type=int, default=None, metavar="N", help="Fetch at most N contacts (for testing).")
    ap.add_argument("--log-level", default="WARNING")
    args = ap.parse_args()

    logging.basicConfig(level=getattr(logging, args.log_level), format="[%(levelname)s] %(message)s")

    # OAuth
    try:
        creds = get_credentials()
    except GcalAuthError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)

    try:
        svc = build("people", "v1", credentials=creds, cache_discovery=False)
        # Quick health check — list 1 contact to verify contacts.readonly scope
        svc.people().connections().list(
            resourceName="people/me", pageSize=1, personFields="names"
        ).execute()
    except HttpError as e:
        details_str = str(e.error_details) if hasattr(e, "error_details") else ""
        if "SERVICE_DISABLED" in details_str or "people.googleapis.com" in details_str:
            url = f"https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=375739772842"
            print(
                f"ERROR: People API is not enabled for this Google Cloud project.\n"
                f"Enable it here (one click, takes ~1 min to propagate):\n"
                f"  {url}",
                file=sys.stderr,
            )
        elif e.status_code in (401, 403):
            print(
                f"ERROR: Google People API returned {e.status_code}.\n"
                "The current OAuth token may lack the contacts.readonly scope.\n"
                "Re-run the OAuth setup to re-consent:\n"
                "  python -m mml_classifier.gcal_oauth_setup",
                file=sys.stderr,
            )
        else:
            print(f"ERROR: People API error: {e}", file=sys.stderr)
        sys.exit(2)

    # Load stored sync_token (for incremental re-sync)
    sync_token: str | None = None
    if not args.full:
        with db.read_only() as con:
            row = con.execute("SELECT sync_token FROM contacts_sync_state WHERE id = 1").fetchone()
            if row:
                sync_token = row["sync_token"]
                if sync_token:
                    print(f"Incremental sync (stored token found). Use --full to re-fetch everything.")

    print("Fetching contact group labels…")
    group_labels = _fetch_group_labels(svc)
    print(f"  {len(group_labels)} groups: {sorted(set(group_labels.values()))[:20]}")

    print(f"Fetching contacts from People API{' (limit=' + str(args.limit) + ')' if args.limit else ''}…")
    contacts, next_sync_token = _fetch_all_contacts(svc, limit=args.limit, sync_token=sync_token)
    print(f"  Fetched {len(contacts)} contacts.")

    print("Resolving against warehouse…")
    plan = _build_plan(contacts)

    _print_report(plan, group_labels, len(contacts))

    if args.commit:
        print("\nApplying changes…")
        _commit_plan(plan, group_labels, next_sync_token)
    else:
        print("\n(Dry-run — no changes written. Re-run with --commit to apply.)")


if __name__ == "__main__":
    main()
