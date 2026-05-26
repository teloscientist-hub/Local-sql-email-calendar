"""Mailspring → warehouse intake (Phase 4 v1).

Reads ~/Library/Application Support/Mailspring/edgehill.db (read-only) and
inserts new messages + recipients into warehouse.sqlite. Skips messages whose
RFC-822 headerMessageId is already in messages.message_id (idempotent).

Defaults to dry-run; pass --commit to actually write. Pre-write APFS-clones
warehouse.sqlite to a backup file before any mutation.

CLI:
    python -m mml_classifier.mailspring_intake             # dry-run, all post-cutoff
    python -m mml_classifier.mailspring_intake --commit    # actually write
    python -m mml_classifier.mailspring_intake --limit 50  # cap for safe testing
    python -m mml_classifier.mailspring_intake --since 2026-05-08T00:00:00

Plan: PLAN_PHASE4_INTAKE.md
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
from typing import Any
from urllib.parse import quote

from . import config

log = logging.getLogger(__name__)

INTAKE_VERSION = "mailspring-intake-v0.1.0"
MAILSPRING_PST_FILENAME = "mailspring-live-ingest"
DEFAULT_EDGEHILL_DB = Path(
    os.path.expanduser("~/Library/Application Support/Mailspring/edgehill.db")
)


# ---------------------------------------------------------------------------
# Connection helpers (edgehill is RO; warehouse may be RO in dry-run, RW on commit)


@contextmanager
def _edgehill_ro(path: Path):
    uri = f"file:{quote(str(path))}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()


@contextmanager
def _warehouse(*, mode: str):
    uri = f"file:{quote(str(config.WAREHOUSE_DB))}?mode={mode}"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    # FK enforcement so misshapen inserts surface immediately.
    con.execute("PRAGMA foreign_keys = ON;")
    try:
        yield con
    finally:
        con.close()


# ---------------------------------------------------------------------------
# Data shapes


@dataclass
class IntakePlan:
    """What a dry-run would do. Built before any writes."""
    cutoff_iso: str
    cutoff_unix: int
    new_messages: list[dict[str, Any]] = field(default_factory=list)
    skipped_no_msgid: int = 0
    skipped_already_present: int = 0
    seen_msgids: set[str] = field(default_factory=set)
    new_addrs: dict[str, str] = field(default_factory=dict)  # email_lower → display_name
    new_folders: dict[str, str] = field(default_factory=dict)  # role → name
    edgehill_total: int = 0
    edgehill_post_cutoff: int = 0


@dataclass
class IntakeStats:
    messages_inserted: int = 0
    recipients_inserted: int = 0
    contacts_inserted: int = 0
    contact_email_map_inserted: int = 0
    folders_inserted: int = 0
    pst_source_inserted: int = 0


# ---------------------------------------------------------------------------
# Edgehill row → normalized record


def _parse_data_blob(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _addr_lower(addr: str | None) -> str | None:
    if not addr:
        return None
    a = addr.strip().lower()
    return a or None


def _normalize_message(row: sqlite3.Row, body: str | None) -> dict[str, Any] | None:
    """Convert an edgehill Message row to a warehouse-shaped dict, or None to skip."""
    rfc = (row["headerMessageId"] or "").strip().strip('<>').strip()
    if not rfc:
        return None

    data = _parse_data_blob(row["data"])
    from_arr = data.get("from") or []
    sender = (from_arr[0] if from_arr else {}) or {}
    sender_email = _addr_lower(sender.get("email"))
    sender_name = sender.get("name") or None

    to_arr = [r for r in (data.get("to") or []) if r and r.get("email")]
    cc_arr = [r for r in (data.get("cc") or []) if r and r.get("email")]
    bcc_arr = [r for r in (data.get("bcc") or []) if r and r.get("email")]

    folder = data.get("folder") or {}
    folder_role = (folder.get("role") or folder.get("path") or "unknown").lower()
    folder_name = folder.get("path") or folder.get("role") or "unknown"

    in_reply_to = data.get("replyToHeaderMessageId") or None
    if not in_reply_to:
        # Mailspring sometimes sticks reply-to into extraHeaders
        eh = data.get("extraHeaders") or {}
        for k, v in eh.items():
            if k.lower() == "in-reply-to":
                in_reply_to = v
                break

    unix_date = row["date"] or data.get("date") or 0
    try:
        iso_date = dt.datetime.fromtimestamp(int(unix_date), tz=dt.timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError):
        iso_date = None

    return {
        "message_id": rfc,
        "in_reply_to": in_reply_to,
        "subject": row["subject"] or data.get("subject") or "",
        "sender_name": sender_name,
        "sender_addr": sender_email,
        "sent_date": iso_date,
        "received_date": iso_date,
        "body_plain": body,  # may be None
        "source_file": f"edgehill:{row['id']}",
        "folder_role": folder_role,
        "folder_name": folder_name,
        "to": [{"email": _addr_lower(r["email"]), "name": r.get("name")} for r in to_arr],
        "cc": [{"email": _addr_lower(r["email"]), "name": r.get("name")} for r in cc_arr],
        "bcc": [{"email": _addr_lower(r["email"]), "name": r.get("name")} for r in bcc_arr],
    }


# ---------------------------------------------------------------------------
# Dry-run plan builder


def _warehouse_cutoff_unix(con: sqlite3.Connection) -> tuple[str, int]:
    row = con.execute("SELECT MAX(received_date) AS mx FROM messages").fetchone()
    iso = row["mx"] or "1970-01-01T00:00:00"
    # received_date format in warehouse: '2026-05-07T06:40:24'  (ISO, sometimes
    # legacy non-ISO from PST). Best-effort parse.
    try:
        d = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        # Try a couple of other shapes seen in PST-imported rows
        try:
            d = dt.datetime.strptime(iso, "%a, %d %m %Y %H:%M:%S")
        except ValueError:
            log.warning("could not parse warehouse cutoff %r — defaulting to 2026-05-07", iso)
            d = dt.datetime(2026, 5, 7, tzinfo=dt.timezone.utc)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return iso, int(d.timestamp())


def _warehouse_existing_msgids(
    con: sqlite3.Connection, candidate_msgids: list[str]
) -> set[str]:
    """Return subset of candidate_msgids already present in messages.message_id."""
    if not candidate_msgids:
        return set()
    found: set[str] = set()
    # SQLite parameter limit ~999; chunk just in case.
    chunk = 500
    for i in range(0, len(candidate_msgids), chunk):
        batch = candidate_msgids[i : i + chunk]
        placeholders = ",".join("?" * len(batch))
        rows = con.execute(
            f"SELECT message_id FROM messages WHERE message_id IN ({placeholders})",
            batch,
        ).fetchall()
        found.update(r["message_id"] for r in rows)
    return found


def _existing_emails(con: sqlite3.Connection) -> set[str]:
    rows = con.execute("SELECT email FROM contact_email_map").fetchall()
    return {r["email"] for r in rows}


def build_plan(
    edgehill_db: Path,
    *,
    since_iso: str | None = None,
    limit: int | None = None,
) -> IntakePlan:
    """Read edgehill, filter by cutoff/since/limit, dedup against warehouse, return plan."""
    with _warehouse(mode="ro") as wh:
        cutoff_iso, cutoff_unix = _warehouse_cutoff_unix(wh)
        if since_iso:
            try:
                d = dt.datetime.fromisoformat(since_iso)
                if d.tzinfo is None:
                    d = d.replace(tzinfo=dt.timezone.utc)
                cutoff_iso = since_iso
                cutoff_unix = int(d.timestamp())
            except ValueError as e:
                raise SystemExit(f"--since not parseable as ISO 8601: {since_iso}: {e}")

        existing_emails = _existing_emails(wh)

        log.info("warehouse cutoff: %s (unix %d)", cutoff_iso, cutoff_unix)

        plan = IntakePlan(cutoff_iso=cutoff_iso, cutoff_unix=cutoff_unix)

        # Walk edgehill
        with _edgehill_ro(edgehill_db) as eh:
            tot = eh.execute("SELECT COUNT(*) AS n FROM Message").fetchone()["n"]
            plan.edgehill_total = tot
            post = eh.execute(
                "SELECT COUNT(*) AS n FROM Message WHERE date > ?", (cutoff_unix,)
            ).fetchone()["n"]
            plan.edgehill_post_cutoff = post

            sql = "SELECT * FROM Message WHERE date > ? ORDER BY date ASC"
            if limit:
                sql += f" LIMIT {int(limit)}"

            candidates: list[dict[str, Any]] = []
            for row in eh.execute(sql, (cutoff_unix,)):
                rfc = (row["headerMessageId"] or "").strip()
                if not rfc:
                    plan.skipped_no_msgid += 1
                    continue
                body_row = eh.execute(
                    "SELECT value FROM MessageBody WHERE id = ?", (row["id"],)
                ).fetchone()
                body = body_row["value"] if body_row else None
                rec = _normalize_message(row, body)
                if rec is None:
                    plan.skipped_no_msgid += 1
                    continue
                candidates.append(rec)

            # Dedup pass: which RFC IDs are already in warehouse?
            cand_msgids = [c["message_id"] for c in candidates]
            already = _warehouse_existing_msgids(wh, cand_msgids)
            for c in candidates:
                if c["message_id"] in already:
                    plan.skipped_already_present += 1
                    continue
                if c["message_id"] in plan.seen_msgids:
                    # duplicate within this batch (Mailspring cross-account dupe) — keep one
                    plan.skipped_already_present += 1
                    continue
                plan.seen_msgids.add(c["message_id"])
                plan.new_messages.append(c)

                # Track new addresses (sender + recipients)
                if c["sender_addr"] and c["sender_addr"] not in existing_emails:
                    plan.new_addrs.setdefault(c["sender_addr"], c["sender_name"] or c["sender_addr"])
                for kind in ("to", "cc", "bcc"):
                    for r in c[kind]:
                        if r["email"] and r["email"] not in existing_emails:
                            plan.new_addrs.setdefault(r["email"], r.get("name") or r["email"])

                # Track new folder roles
                role = c["folder_role"]
                if role and role not in plan.new_folders:
                    plan.new_folders[role] = c["folder_name"]

    return plan


# ---------------------------------------------------------------------------
# Commit path — writes everything inside one transaction


def _ensure_pst_source(con: sqlite3.Connection, edgehill_path: Path) -> int:
    row = con.execute(
        "SELECT id FROM pst_sources WHERE filename = ?", (MAILSPRING_PST_FILENAME,)
    ).fetchone()
    if row:
        return row["id"]
    size = edgehill_path.stat().st_size if edgehill_path.exists() else 0
    cur = con.execute(
        """
        INSERT INTO pst_sources (filename, full_path, size_bytes, imported_at,
                                 ingester_version, parser_version)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            MAILSPRING_PST_FILENAME,
            str(edgehill_path),
            size,
            dt.datetime.now(tz=dt.timezone.utc).isoformat(timespec="seconds"),
            INTAKE_VERSION,
            INTAKE_VERSION,
        ),
    )
    return int(cur.lastrowid)


def _ensure_folder(
    con: sqlite3.Connection, pst_source_id: int, role: str, name: str
) -> int:
    full_path = f"/{name}"
    row = con.execute(
        """
        SELECT id FROM folders
        WHERE pst_source_id = ? AND full_path = ?
        """,
        (pst_source_id, full_path),
    ).fetchone()
    if row:
        return row["id"]
    cur = con.execute(
        """
        INSERT INTO folders (pst_source_id, parent_folder_id, name, full_path, depth, tombstone)
        VALUES (?, NULL, ?, ?, 0, 0)
        """,
        (pst_source_id, name, full_path),
    )
    return int(cur.lastrowid)


def _ensure_contact(
    con: sqlite3.Connection, email_lower: str, display_name: str | None, now_iso: str
) -> tuple[int, bool, bool]:
    """Return (entity_id, created_entity, created_email_map)."""
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
                                      created_at, updated_at, is_mark, is_list_addr, tombstone)
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


def commit_plan(plan: IntakePlan, edgehill_db: Path) -> IntakeStats:
    stats = IntakeStats()
    now_iso = dt.datetime.now(tz=dt.timezone.utc).isoformat(timespec="seconds")

    with _warehouse(mode="rw") as wh:
        wh.execute("BEGIN")
        try:
            # 1. Ensure pst_source row
            existing_pst = wh.execute(
                "SELECT id FROM pst_sources WHERE filename = ?",
                (MAILSPRING_PST_FILENAME,),
            ).fetchone()
            pst_id = _ensure_pst_source(wh, edgehill_db)
            if not existing_pst:
                stats.pst_source_inserted = 1

            # 2. Ensure folder rows (one per role we'll reference)
            folder_id_by_role: dict[str, int] = {}
            for role, name in plan.new_folders.items():
                existing_folder = wh.execute(
                    "SELECT id FROM folders WHERE pst_source_id = ? AND full_path = ?",
                    (pst_id, f"/{name}"),
                ).fetchone()
                folder_id_by_role[role] = _ensure_folder(wh, pst_id, role, name)
                if not existing_folder:
                    stats.folders_inserted += 1

            # 3. Insert messages + recipients; ensure contacts as we go.
            for c in plan.new_messages:
                folder_id = folder_id_by_role.get(c["folder_role"])
                # Ensure sender contact (no FK in messages → contact_entities, but
                # we still want it consistent for engagement bootstraps later)
                if c["sender_addr"]:
                    _, e_created, m_created = _ensure_contact(
                        wh, c["sender_addr"], c["sender_name"], now_iso
                    )
                    if e_created:
                        stats.contacts_inserted += 1
                    if m_created:
                        stats.contact_email_map_inserted += 1

                cur = wh.execute(
                    """
                    INSERT INTO messages (pst_source_id, folder_id, message_id, in_reply_to,
                                          subject, sender_name, sender_addr, sent_date,
                                          received_date, body_plain, source_file,
                                          parser_version, tombstone)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                    """,
                    (
                        pst_id,
                        folder_id,
                        c["message_id"],
                        c["in_reply_to"],
                        c["subject"],
                        c["sender_name"],
                        c["sender_addr"],
                        c["sent_date"],
                        c["received_date"],
                        c["body_plain"],
                        c["source_file"],
                        INTAKE_VERSION,
                    ),
                )
                msg_pk = int(cur.lastrowid)
                stats.messages_inserted += 1

                # Recipients
                for kind in ("to", "cc", "bcc"):
                    for r in c[kind]:
                        if not r["email"]:
                            continue
                        _, e_created, m_created = _ensure_contact(
                            wh, r["email"], r.get("name"), now_iso
                        )
                        if e_created:
                            stats.contacts_inserted += 1
                        if m_created:
                            stats.contact_email_map_inserted += 1
                        wh.execute(
                            """
                            INSERT INTO recipients (message_id, kind, name, addr, tombstone)
                            VALUES (?, ?, ?, ?, 0)
                            """,
                            (msg_pk, kind, r.get("name"), r["email"]),
                        )
                        stats.recipients_inserted += 1

            wh.execute("COMMIT")
        except Exception:
            wh.execute("ROLLBACK")
            raise

    return stats


# ---------------------------------------------------------------------------
# CLI


def _print_dry_run_summary(plan: IntakePlan) -> None:
    print()
    print("=== Mailspring → warehouse intake — DRY RUN ===")
    print(f"warehouse cutoff (received_date max): {plan.cutoff_iso}")
    print(f"edgehill total messages:               {plan.edgehill_total:,}")
    print(f"edgehill post-cutoff messages:         {plan.edgehill_post_cutoff:,}")
    print()
    print(f"would insert messages:                 {len(plan.new_messages):,}")
    print(f"would insert new contacts (entities):  {len(plan.new_addrs):,}")
    print(f"would insert new folders (synthetic):  {len(plan.new_folders):,}")
    print(f"skipped (no headerMessageId):          {plan.skipped_no_msgid:,}")
    print(f"skipped (already in warehouse):        {plan.skipped_already_present:,}")
    print()
    if plan.new_folders:
        print("new folder roles → names:")
        for role, name in sorted(plan.new_folders.items()):
            print(f"   {role:12s}  →  {name}")
        print()
    if plan.new_messages:
        print("first 5 messages that would be inserted:")
        for i, c in enumerate(plan.new_messages[:5], 1):
            subj = (c["subject"] or "").replace("\n", " ")[:70]
            print(f"  {i}. [{c['received_date']}] {c['sender_addr'] or '<no-sender>'}")
            print(f"     subject: {subj}")
            print(f"     msgid:   {c['message_id']}")
            print(f"     to:      {len(c['to'])}, cc: {len(c['cc'])}, bcc: {len(c['bcc'])}")
        print()
    if plan.new_addrs:
        sample = list(plan.new_addrs.items())[:10]
        print("sample of new addresses (max 10):")
        for email, name in sample:
            print(f"   {email}  ({name})")
        print()
    print("Run again with --commit to actually write.  A backup of warehouse.sqlite")
    print("will be made at <warehouse>.pre-mailspring-intake-<ISO> before any writes.")


def _backup_warehouse() -> Path:
    """APFS clone the warehouse before any --commit run."""
    src = config.WAREHOUSE_DB
    iso = dt.datetime.now(tz=dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    dst = src.with_suffix(src.suffix + f".pre-mailspring-intake-{iso}")
    log.info("backing up warehouse → %s", dst)
    # Use cp -c for APFS clone; falls back to regular copy if -c isn't supported.
    try:
        os.system(f'cp -c "{src}" "{dst}"')
    except Exception:
        shutil.copy2(src, dst)
    if not dst.exists():
        shutil.copy2(src, dst)
    return dst


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Mailspring → warehouse intake (dry-run by default)."
    )
    ap.add_argument(
        "--commit",
        action="store_true",
        help="Actually write to the warehouse. Without this flag, prints what it would do.",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap edgehill messages processed per run (for testing).",
    )
    ap.add_argument(
        "--since",
        default=None,
        help="ISO 8601 datetime; overrides the warehouse-MAX cutoff (e.g. 2026-05-08T00:00:00).",
    )
    ap.add_argument(
        "--edgehill-db",
        default=str(DEFAULT_EDGEHILL_DB),
        help=f"Path to edgehill.db (default: {DEFAULT_EDGEHILL_DB})",
    )
    ap.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    edgehill_db = Path(args.edgehill_db)
    if not edgehill_db.exists():
        print(f"edgehill.db not found at {edgehill_db}", file=sys.stderr)
        return 2

    plan = build_plan(edgehill_db, since_iso=args.since, limit=args.limit)

    if not args.commit:
        _print_dry_run_summary(plan)
        return 0

    if not plan.new_messages:
        print("no new messages to insert; nothing to do.")
        return 0

    backup = _backup_warehouse()
    print(f"backup written to: {backup}")
    stats = commit_plan(plan, edgehill_db)

    print()
    print("=== INTAKE COMMIT COMPLETE ===")
    print(f"messages inserted:           {stats.messages_inserted:,}")
    print(f"recipients inserted:         {stats.recipients_inserted:,}")
    print(f"new contact_entities:        {stats.contacts_inserted:,}")
    print(f"new contact_email_map rows:  {stats.contact_email_map_inserted:,}")
    print(f"new folders:                 {stats.folders_inserted}")
    print(f"new pst_sources rows:        {stats.pst_source_inserted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
