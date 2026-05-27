"""Ingest messages from an mbox file (or Google Takeout .mbox) into warehouse.sqlite.

Targets the existing pst_sources / folders / messages / recipients schema.
Idempotent: skips messages whose Message-ID is already present for this source.
Dry-run by default; pass --commit to write.

CLI:
    python -m pipeline.ingest_mbox <mbox_path> <warehouse.sqlite> [--label NAME] [--commit]

Examples:
    # Google Takeout — dry-run
    python -m pipeline.ingest_mbox ~/Downloads/All mail Including Spam and Trash.mbox warehouse.sqlite

    # Commit with an explicit folder label
    python -m pipeline.ingest_mbox archive.mbox warehouse.sqlite --label "Archive" --commit
"""
from __future__ import annotations

import argparse
import email
import email.policy
import hashlib
import mailbox
import os
import sqlite3
import sys
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime

PARSER_VERSION = "mbox-ingest@0.1.0"
BATCH_SIZE = 500


# ---------------------------------------------------------------------------
# Helpers

def _decode_header_str(raw: str | None) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    out = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            try:
                out.append(chunk.decode(charset or "utf-8", errors="replace"))
            except (LookupError, UnicodeDecodeError):
                out.append(chunk.decode("latin-1", errors="replace"))
        else:
            out.append(chunk)
    return "".join(out).strip()


def _addr_lower(raw: str | None) -> str | None:
    if not raw:
        return None
    _, addr = parseaddr(raw)
    a = addr.strip().lower()
    return a if a else None


def _parse_date(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
        return dt.isoformat(timespec="seconds")
    except Exception:
        return None


def _addr_list(header_val: str | None) -> list[tuple[str | None, str | None]]:
    """Parse a To/Cc/Bcc header into list of (name, email_lower) tuples."""
    if not header_val:
        return []
    results = []
    for part in header_val.split(","):
        name, addr = parseaddr(part.strip())
        addr_low = addr.strip().lower() if addr.strip() else None
        if addr_low:
            results.append((name.strip() or None, addr_low))
    return results


def _extract_body(msg: email.message.Message) -> tuple[str | None, str | None]:
    plain, html = None, None
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if part.get_content_disposition() == "attachment":
                continue
            if ct == "text/plain" and plain is None:
                try:
                    plain = part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", errors="replace")
                except Exception:
                    pass
            elif ct == "text/html" and html is None:
                try:
                    html = part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", errors="replace")
                except Exception:
                    pass
    else:
        ct = msg.get_content_type()
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                text = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")
                if ct == "text/html":
                    html = text
                else:
                    plain = text
        except Exception:
            pass
    return plain, html


def _gmail_labels(msg: email.message.Message) -> str | None:
    """Extract X-Gmail-Labels header (Google Takeout mbox extension)."""
    return msg.get("X-Gmail-Labels") or None


# ---------------------------------------------------------------------------
# DB helpers

def _open_warehouse(path: str, readonly: bool) -> sqlite3.Connection:
    mode = "ro" if readonly else "rwc"
    uri = f"file:{path}?mode={mode}"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def _ensure_pst_source(con: sqlite3.Connection, mbox_path: str) -> int:
    fname = os.path.basename(mbox_path)
    row = con.execute(
        "SELECT id FROM pst_sources WHERE filename = ? AND full_path = ?",
        (fname, os.path.abspath(mbox_path)),
    ).fetchone()
    if row:
        return int(row["id"])
    size = os.path.getsize(mbox_path) if os.path.exists(mbox_path) else 0
    cur = con.execute(
        "INSERT INTO pst_sources (filename, full_path, size_bytes, imported_at, "
        "ingester_version, parser_version) VALUES (?, ?, ?, datetime('now'), ?, ?)",
        (fname, os.path.abspath(mbox_path), size, PARSER_VERSION, PARSER_VERSION),
    )
    return int(cur.lastrowid)


def _ensure_folder(con: sqlite3.Connection, pst_source_id: int, label: str) -> int:
    full_path = f"/{label}"
    row = con.execute(
        "SELECT id FROM folders WHERE pst_source_id = ? AND full_path = ?",
        (pst_source_id, full_path),
    ).fetchone()
    if row:
        return int(row["id"])
    cur = con.execute(
        "INSERT INTO folders (pst_source_id, parent_folder_id, name, full_path, depth, tombstone) "
        "VALUES (?, NULL, ?, ?, 0, 0)",
        (pst_source_id, label, full_path),
    )
    return int(cur.lastrowid)


def _ensure_contact(
    con: sqlite3.Connection, email_lower: str, display_name: str | None
) -> int:
    row = con.execute(
        "SELECT contact_entity_id FROM contact_email_map WHERE email = ?",
        (email_lower,),
    ).fetchone()
    if row:
        return int(row["contact_entity_id"])
    canonical_name = (display_name or email_lower).strip() or email_lower
    cur = con.execute(
        "INSERT INTO contact_entities (canonical_name, canonical_email, is_me, is_list_addr, "
        "created_at, updated_at, ingester_version, tombstone) "
        "VALUES (?, ?, 0, 0, datetime('now'), datetime('now'), ?, 0)",
        (canonical_name, email_lower, PARSER_VERSION),
    )
    entity_id = int(cur.lastrowid)
    con.execute(
        "INSERT INTO contact_email_map (email, contact_entity_id, primary_for_contact, "
        "first_seen_at, last_seen_at, tombstone) VALUES (?, ?, 1, datetime('now'), datetime('now'), 0)",
        (email_lower, entity_id),
    )
    return entity_id


def _load_existing_msgids(con: sqlite3.Connection, pst_source_id: int) -> set[str]:
    rows = con.execute(
        "SELECT message_id FROM messages WHERE pst_source_id = ? AND message_id IS NOT NULL",
        (pst_source_id,),
    ).fetchall()
    return {r["message_id"] for r in rows}


# ---------------------------------------------------------------------------
# Core ingest loop

def ingest(
    mbox_path: str,
    warehouse_path: str,
    label: str,
    commit: bool,
) -> dict[str, int]:
    stats = {"parsed": 0, "inserted": 0, "skipped_dup": 0, "skipped_no_msgid": 0, "errors": 0}

    # Open warehouse for reading to check existing message IDs
    ro_con = _open_warehouse(warehouse_path, readonly=True)
    pst_source_id_probe = ro_con.execute(
        "SELECT id FROM pst_sources WHERE filename = ? AND full_path = ?",
        (os.path.basename(mbox_path), os.path.abspath(mbox_path)),
    ).fetchone()
    existing_msgids: set[str] = set()
    if pst_source_id_probe:
        existing_msgids = _load_existing_msgids(ro_con, int(pst_source_id_probe["id"]))
    ro_con.close()

    seen_in_batch: set[str] = set()
    pending: list[dict] = []

    mb = mailbox.mbox(mbox_path, factory=None, create=False)

    def _flush(con: sqlite3.Connection, rows: list[dict]) -> None:
        for r in rows:
            folder_id = _ensure_folder(con, r["pst_source_id"], r["label"])
            if r["sender_addr"]:
                _ensure_contact(con, r["sender_addr"], r["sender_name"])
            cur = con.execute(
                "INSERT INTO messages (pst_source_id, folder_id, message_id, in_reply_to, "
                "subject, sender_name, sender_addr, sent_date, received_date, "
                "body_plain, body_html, source_file, parser_version, tombstone) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
                (
                    r["pst_source_id"], folder_id, r["message_id"], r["in_reply_to"],
                    r["subject"], r["sender_name"], r["sender_addr"],
                    r["sent_date"], r["sent_date"],
                    r["body_plain"], r["body_html"],
                    r["source_file"], PARSER_VERSION,
                ),
            )
            msg_pk = int(cur.lastrowid)
            for kind in ("to", "cc", "bcc"):
                for name, addr in r[kind]:
                    _ensure_contact(con, addr, name)
                    con.execute(
                        "INSERT INTO recipients (message_id, kind, name, addr, tombstone) "
                        "VALUES (?, ?, ?, ?, 0)",
                        (msg_pk, kind, name, addr),
                    )

    if commit:
        wh_con = _open_warehouse(warehouse_path, readonly=False)
        wh_con.execute("BEGIN")
        pst_source_id = _ensure_pst_source(wh_con, mbox_path)
    else:
        wh_con = None
        pst_source_id = pst_source_id_probe["id"] if pst_source_id_probe else -1

    try:
        for key, msg_bytes in mb.items():
            stats["parsed"] += 1
            try:
                if isinstance(msg_bytes, email.message.Message):
                    msg = msg_bytes
                else:
                    raw = bytes(msg_bytes)
                    msg = email.message_from_bytes(raw, policy=email.policy.compat32)

                raw_msgid = (msg.get("Message-ID") or "").strip().strip("<>").strip()
                if not raw_msgid:
                    stats["skipped_no_msgid"] += 1
                    continue

                if raw_msgid in existing_msgids or raw_msgid in seen_in_batch:
                    stats["skipped_dup"] += 1
                    continue
                seen_in_batch.add(raw_msgid)

                from_raw = msg.get("From") or ""
                sender_name, sender_addr_raw = parseaddr(from_raw)
                sender_name = _decode_header_str(sender_name) or None
                sender_addr = _addr_lower(sender_addr_raw)

                gmail_labels = _gmail_labels(msg)
                effective_label = label
                if gmail_labels and label == os.path.basename(mbox_path):
                    # Use first Gmail label as folder name for Takeout mboxes
                    first_label = gmail_labels.split(",")[0].strip()
                    if first_label:
                        effective_label = first_label

                subject = _decode_header_str(msg.get("Subject"))
                sent_date = _parse_date(msg.get("Date"))
                in_reply_to = (msg.get("In-Reply-To") or "").strip().strip("<>").strip() or None
                body_plain, body_html = _extract_body(msg)

                to_addrs = _addr_list(_decode_header_str(msg.get("To")))
                cc_addrs = _addr_list(_decode_header_str(msg.get("Cc")))
                bcc_addrs = _addr_list(_decode_header_str(msg.get("Bcc")))

                rec = {
                    "pst_source_id": pst_source_id,
                    "label": effective_label,
                    "message_id": raw_msgid,
                    "in_reply_to": in_reply_to,
                    "subject": subject,
                    "sender_name": sender_name,
                    "sender_addr": sender_addr,
                    "sent_date": sent_date,
                    "body_plain": body_plain,
                    "body_html": body_html,
                    "source_file": f"mbox:{os.path.basename(mbox_path)}:{key}",
                    "to": to_addrs,
                    "cc": cc_addrs,
                    "bcc": bcc_addrs,
                }
                pending.append(rec)
                stats["inserted"] += 1

                if commit and len(pending) >= BATCH_SIZE:
                    _flush(wh_con, pending)
                    wh_con.execute("COMMIT")
                    wh_con.execute("BEGIN")
                    pending.clear()

            except Exception as exc:
                stats["errors"] += 1
                print(f"  [error] message {key}: {exc}", file=sys.stderr)

        if commit and pending:
            _flush(wh_con, pending)
            wh_con.execute("COMMIT")

    except Exception:
        if commit and wh_con:
            wh_con.execute("ROLLBACK")
        raise
    finally:
        if commit and wh_con:
            wh_con.close()
        mb.close()

    return stats


# ---------------------------------------------------------------------------
# CLI

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Ingest an mbox / Google Takeout .mbox into warehouse.sqlite. "
                    "Dry-run by default; pass --commit to write."
    )
    ap.add_argument("mbox", help="Path to the .mbox file.")
    ap.add_argument("warehouse", help="Path to warehouse.sqlite.")
    ap.add_argument(
        "--label",
        default=None,
        help="Folder label to use for all messages in this mbox. "
             "Defaults to the mbox filename. For Google Takeout mboxes the "
             "X-Gmail-Labels header is used when available.",
    )
    ap.add_argument(
        "--commit",
        action="store_true",
        help="Write to warehouse. Without this flag, only prints counts.",
    )
    args = ap.parse_args()

    mbox_path = os.path.abspath(args.mbox)
    warehouse_path = os.path.abspath(args.warehouse)
    label = args.label or os.path.basename(mbox_path)

    if not os.path.exists(mbox_path):
        print(f"ERROR: mbox not found: {mbox_path}", file=sys.stderr)
        return 2
    if not os.path.exists(warehouse_path):
        print(f"ERROR: warehouse not found: {warehouse_path}", file=sys.stderr)
        return 2

    mode = "COMMIT" if args.commit else "DRY-RUN"
    print(f"=== ingest_mbox [{mode}] ===")
    print(f"  mbox      : {mbox_path}")
    print(f"  warehouse : {warehouse_path}")
    print(f"  label     : {label}")
    print()

    stats = ingest(mbox_path, warehouse_path, label, commit=args.commit)

    print(f"messages parsed          : {stats['parsed']:,}")
    print(f"messages inserted        : {stats['inserted']:,}")
    print(f"skipped (duplicate)      : {stats['skipped_dup']:,}")
    print(f"skipped (no Message-ID)  : {stats['skipped_no_msgid']:,}")
    print(f"errors                   : {stats['errors']:,}")

    if not args.commit:
        print()
        print("Dry-run — no changes written. Re-run with --commit to apply.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
