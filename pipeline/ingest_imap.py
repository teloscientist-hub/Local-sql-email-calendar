"""Fetch messages from an IMAP folder → local .mbox file.

This is a thin fetcher only — it does NOT write to the warehouse.
After it finishes, run ingest_mbox.py on the output file:

    python -m pipeline.ingest_mbox <out.mbox> warehouse.sqlite --commit

Idempotent at the mbox level: before fetching, it scans the existing output
file (if any) for known Message-IDs and skips UIDs whose Message-ID is
already present.

Gmail notes (see module docstring below for full details):
  - Enable IMAP in Gmail Settings → See all settings → Forwarding and POP/IMAP.
  - Use an App Password, not your regular Gmail password (basic auth is blocked).
    Generate one at myaccount.google.com/apppasswords.
  - Alternatively, export via Google Takeout (.mbox) and skip this script.

CLI:
    python -m pipeline.ingest_imap \\
        --host imap.gmail.com --user you@gmail.com \\
        --folder INBOX --out inbox.mbox

    # IMAP_PASSWORD env var skips the getpass prompt:
    IMAP_PASSWORD=app_password python -m pipeline.ingest_imap ...
"""
from __future__ import annotations

import argparse
import email
import email.policy
import getpass
import imaplib
import mailbox
import os
import ssl
import sys
from email.header import decode_header


# ---------------------------------------------------------------------------
# Helpers

def _decode_header_str(raw: str | bytes | None) -> str:
    if not raw:
        return ""
    if isinstance(raw, bytes):
        raw = raw.decode("latin-1", errors="replace")
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


def _extract_message_id(raw_bytes: bytes) -> str | None:
    """Extract Message-ID without parsing the full message."""
    try:
        msg = email.message_from_bytes(raw_bytes, policy=email.policy.compat32)
        mid = (msg.get("Message-ID") or "").strip().strip("<>").strip()
        return mid if mid else None
    except Exception:
        return None


def _load_existing_msgids(mbox_path: str) -> set[str]:
    """Scan an existing mbox and return the set of Message-IDs already present."""
    if not os.path.exists(mbox_path):
        return set()
    known: set[str] = set()
    try:
        mb = mailbox.mbox(mbox_path, factory=None, create=False)
        for msg in mb:
            mid = (msg.get("Message-ID") or "").strip().strip("<>").strip()
            if mid:
                known.add(mid)
        mb.close()
    except Exception as exc:
        print(f"[warning] could not scan existing mbox: {exc}", file=sys.stderr)
    return known


def _uid_batches(uids: list[bytes], size: int = 100):
    for i in range(0, len(uids), size):
        yield uids[i : i + size]


# ---------------------------------------------------------------------------
# Core fetch

def fetch_to_mbox(
    host: str,
    port: int,
    user: str,
    password: str,
    folder: str,
    out_path: str,
) -> dict[str, int]:
    stats = {"total_uids": 0, "fetched": 0, "skipped_dup": 0, "errors": 0}

    existing_msgids = _load_existing_msgids(out_path)
    print(f"  existing messages in {os.path.basename(out_path)}: {len(existing_msgids):,}")

    ctx = ssl.create_default_context()
    imap = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    try:
        imap.login(user, password)
    except imaplib.IMAP4.error as exc:
        print(f"ERROR: IMAP login failed: {exc}", file=sys.stderr)
        sys.exit(2)

    status, data = imap.select(f'"{folder}"', readonly=True)
    if status != "OK":
        print(f"ERROR: could not SELECT folder {folder!r}: {data}", file=sys.stderr)
        imap.logout()
        sys.exit(2)

    status, uid_data = imap.uid("SEARCH", None, "ALL")
    if status != "OK":
        print(f"ERROR: UID SEARCH failed: {uid_data}", file=sys.stderr)
        imap.logout()
        sys.exit(2)

    uid_list: list[bytes] = uid_data[0].split() if uid_data and uid_data[0] else []
    stats["total_uids"] = len(uid_list)
    print(f"  UIDs in {folder!r}: {len(uid_list):,}")

    mb = mailbox.mbox(out_path, create=True)
    mb.lock()

    try:
        for batch in _uid_batches(uid_list, 100):
            uid_str = b",".join(batch).decode()
            try:
                status, fetch_data = imap.uid("FETCH", uid_str, "(RFC822)")
            except Exception as exc:
                stats["errors"] += len(batch)
                print(f"  [error] FETCH batch: {exc}", file=sys.stderr)
                continue

            if status != "OK" or not fetch_data:
                stats["errors"] += len(batch)
                continue

            for item in fetch_data:
                if not isinstance(item, tuple) or len(item) < 2:
                    continue
                raw_bytes = item[1]
                if not isinstance(raw_bytes, bytes):
                    continue

                mid = _extract_message_id(raw_bytes)
                if mid and mid in existing_msgids:
                    stats["skipped_dup"] += 1
                    continue

                try:
                    msg = email.message_from_bytes(raw_bytes, policy=email.policy.compat32)
                    mb.add(msg)
                    if mid:
                        existing_msgids.add(mid)
                    stats["fetched"] += 1
                except Exception as exc:
                    stats["errors"] += 1
                    print(f"  [error] appending message: {exc}", file=sys.stderr)

            mb.flush()

    finally:
        mb.unlock()
        mb.close()
        imap.logout()

    return stats


# ---------------------------------------------------------------------------
# CLI

def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--host", required=True, help="IMAP server hostname (e.g. imap.gmail.com).")
    ap.add_argument("--port", type=int, default=993, help="IMAP SSL port (default 993).")
    ap.add_argument("--user", required=True, help="IMAP username / email address.")
    ap.add_argument(
        "--folder",
        default="INBOX",
        help="IMAP folder to fetch (default INBOX). Use 'LIST' to see available folders.",
    )
    ap.add_argument(
        "--out",
        required=True,
        help="Path to the output .mbox file. Created if absent; appended to if exists.",
    )
    args = ap.parse_args()

    if args.folder.upper() == "LIST":
        # List available folders and exit
        password = os.environ.get("IMAP_PASSWORD") or getpass.getpass(f"Password for {args.user}: ")
        ctx = ssl.create_default_context()
        imap = imaplib.IMAP4_SSL(args.host, args.port, ssl_context=ctx)
        try:
            imap.login(args.user, password)
            status, folders = imap.list()
            if status == "OK":
                print("Available folders:")
                for f in folders:
                    print(" ", f.decode() if isinstance(f, bytes) else f)
        finally:
            imap.logout()
        return 0

    password = os.environ.get("IMAP_PASSWORD") or getpass.getpass(f"Password for {args.user}: ")

    print(f"=== ingest_imap ===")
    print(f"  host   : {args.host}:{args.port}")
    print(f"  user   : {args.user}")
    print(f"  folder : {args.folder}")
    print(f"  out    : {os.path.abspath(args.out)}")
    print()

    stats = fetch_to_mbox(
        host=args.host,
        port=args.port,
        user=args.user,
        password=password,
        folder=args.folder,
        out_path=args.out,
    )

    print()
    print(f"UIDs in folder   : {stats['total_uids']:,}")
    print(f"fetched + written: {stats['fetched']:,}")
    print(f"skipped (dup)    : {stats['skipped_dup']:,}")
    print(f"errors           : {stats['errors']:,}")
    print()
    print("Next step — ingest the mbox into the warehouse:")
    print(f"  python -m pipeline.ingest_mbox {args.out!r} warehouse.sqlite --commit")

    return 0


if __name__ == "__main__":
    sys.exit(main())
