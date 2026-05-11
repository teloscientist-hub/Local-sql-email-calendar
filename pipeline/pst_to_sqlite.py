#!/usr/bin/env python3
"""
PST → SQLite converter
Uses readpst (libpst) to extract emails, then imports into SQLite with full folder hierarchy.

Schema:
  pst_sources  – one row per source PST file
  folders      – one row per Outlook folder, self-referencing parent for hierarchy
  messages     – one row per email
  recipients   – normalized to/cc/bcc rows
"""

import argparse
import email
import email.utils
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from email.header import decode_header as _decode_header
from pathlib import Path


# ── helpers ──────────────────────────────────────────────────────────────────

def decode_header(raw):
    if not raw:
        return ""
    parts = []
    for chunk, enc in _decode_header(raw):
        if isinstance(chunk, bytes):
            try:
                parts.append(chunk.decode(enc or "utf-8", errors="replace"))
            except Exception:
                parts.append(chunk.decode("latin-1", errors="replace"))
        else:
            parts.append(chunk)
    return " ".join(parts).strip()


def parse_date(date_str):
    if not date_str:
        return None
    try:
        t = email.utils.parsedate_to_datetime(date_str)
        return t.isoformat()
    except Exception:
        return date_str


def extract_addresses(raw):
    """Return list of (name, addr) tuples from a header value."""
    if not raw:
        return []
    try:
        return email.utils.getaddresses([raw])
    except Exception:
        return []


def get_body(msg):
    plain, html = None, None
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if "attachment" in cd:
                continue
            if ct == "text/plain" and plain is None:
                plain = _decode_part(part)
            elif ct == "text/html" and html is None:
                html = _decode_part(part)
    else:
        ct = msg.get_content_type()
        if ct == "text/plain":
            plain = _decode_part(msg)
        elif ct == "text/html":
            html = _decode_part(msg)
    return plain, html


def _decode_part(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return None
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except Exception:
        return payload.decode("latin-1", errors="replace")


# ── database setup ────────────────────────────────────────────────────────────

DDL = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS pst_sources (
    id          INTEGER PRIMARY KEY,
    filename    TEXT NOT NULL,
    full_path   TEXT NOT NULL,
    size_bytes  INTEGER,
    imported_at TEXT
);

CREATE TABLE IF NOT EXISTS folders (
    id               INTEGER PRIMARY KEY,
    pst_source_id    INTEGER NOT NULL REFERENCES pst_sources(id),
    parent_folder_id INTEGER REFERENCES folders(id),
    name             TEXT NOT NULL,
    full_path        TEXT NOT NULL,
    depth            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_folders_pst  ON folders(pst_source_id);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(full_path);

CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY,
    pst_source_id INTEGER NOT NULL REFERENCES pst_sources(id),
    folder_id     INTEGER REFERENCES folders(id),
    message_id    TEXT,
    in_reply_to   TEXT,
    subject       TEXT,
    sender_name   TEXT,
    sender_addr   TEXT,
    sent_date     TEXT,
    received_date TEXT,
    body_plain    TEXT,
    body_html     TEXT,
    source_file   TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_pst      ON messages(pst_source_id);
CREATE INDEX IF NOT EXISTS idx_messages_folder   ON messages(folder_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_addr);
CREATE INDEX IF NOT EXISTS idx_messages_sent     ON messages(sent_date);
CREATE INDEX IF NOT EXISTS idx_messages_msgid    ON messages(message_id);

CREATE TABLE IF NOT EXISTS recipients (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    kind       TEXT NOT NULL CHECK(kind IN ('to','cc','bcc')),
    name       TEXT,
    addr       TEXT
);
CREATE INDEX IF NOT EXISTS idx_recipients_msg  ON recipients(message_id);
CREATE INDEX IF NOT EXISTS idx_recipients_addr ON recipients(addr);
"""


def init_db(db_path):
    con = sqlite3.connect(db_path)
    con.executescript(DDL)
    con.commit()
    return con


# ── extraction ────────────────────────────────────────────────────────────────

def run_readpst(pst_path, out_dir):
    """Run readpst -r -M (recursive, individual rfc822 files) into out_dir."""
    cmd = [
        "readpst",
        "-r",        # recursive folder structure
        "-M",        # individual .eml files (rfc822 format)
        "-D",        # include deleted items
        "-q",        # quiet
        "-o", str(out_dir),
        str(pst_path),
    ]
    print(f"  Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode not in (0, 1):  # readpst exits 1 on minor warnings
        print(f"  WARNING: readpst exited {result.returncode}")
        if result.stderr:
            print(f"  STDERR: {result.stderr[:500]}")
    return result.returncode


def build_folder_tree(out_dir, pst_source_id, con):
    """
    Walk the extracted directory tree and insert folder rows.
    Returns dict: absolute_dir_path → folder_id
    """
    out_dir = Path(out_dir)
    folder_map = {}  # abs path str → folder db id

    # BFS via os.walk to guarantee parents are inserted before children
    for root, dirs, files in os.walk(out_dir):
        root_path = Path(root)
        rel = root_path.relative_to(out_dir)
        parts = rel.parts

        if len(parts) == 0:
            # root of extraction — skip, not a real folder
            continue

        depth = len(parts) - 1
        name = parts[-1]
        full_path = str(rel)

        # parent
        if len(parts) == 1:
            parent_id = None
        else:
            parent_rel = Path(*parts[:-1])
            parent_abs = str(out_dir / parent_rel)
            parent_id = folder_map.get(parent_abs)

        cur = con.execute(
            "INSERT INTO folders (pst_source_id, parent_folder_id, name, full_path, depth) "
            "VALUES (?,?,?,?,?)",
            (pst_source_id, parent_id, name, full_path, depth),
        )
        folder_map[str(root_path)] = cur.lastrowid

    con.commit()
    return folder_map


def import_messages(out_dir, pst_source_id, folder_map, con, batch=500):
    """Walk .eml files, parse, and insert into messages + recipients."""
    out_dir = Path(out_dir)
    inserted = 0
    msg_buf = []
    rec_buf = []

    for root, dirs, files in os.walk(out_dir):
        root_path = Path(root)
        folder_id = folder_map.get(str(root_path))

        for fname in files:
            if not (fname.endswith(".eml") or re.match(r"^\d+$", fname)):
                # readpst names files as integers or .eml; skip others
                if not fname.endswith(".msg") and "." not in fname:
                    pass  # likely a numbered file — include it
                elif fname.endswith(".eml"):
                    pass
                else:
                    continue

            fpath = root_path / fname
            try:
                raw = fpath.read_bytes()
                msg = email.message_from_bytes(raw)
            except Exception as e:
                print(f"  SKIP {fpath}: {e}")
                continue

            from_pairs = extract_addresses(msg.get("From", ""))
            sender_name = from_pairs[0][0] if from_pairs else None
            sender_addr = from_pairs[0][1] if from_pairs else None

            plain, html = get_body(msg)

            msg_buf.append((
                pst_source_id,
                folder_id,
                decode_header(msg.get("Message-ID", "")),
                decode_header(msg.get("In-Reply-To", "")),
                decode_header(msg.get("Subject", "")),
                sender_name,
                sender_addr,
                parse_date(msg.get("Date", "")),
                parse_date(msg.get("Received", "").split(";")[-1].strip() if msg.get("Received") else None),
                plain,
                html,
                str(fpath),
            ))

            # recipients are inserted after we know the message rowid
            for kind, header in [("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")]:
                for name, addr in extract_addresses(msg.get(header, "")):
                    rec_buf.append((kind, name, addr))

            if len(msg_buf) >= batch:
                _flush(con, msg_buf, rec_buf)
                inserted += len(msg_buf)
                msg_buf = []
                rec_buf_start = []
                rec_buf = []
                print(f"    … {inserted} messages imported", end="\r")

    if msg_buf:
        _flush(con, msg_buf, rec_buf)
        inserted += len(msg_buf)

    con.commit()
    print(f"    … {inserted} messages imported")
    return inserted


def _flush(con, msg_buf, rec_buf):
    """Insert a batch of messages. rec_buf holds flat list for ALL messages in order."""
    # We need per-message recipient lists; rebuild from scratch by associating
    # recipients inline. Simplest: insert messages one-by-one within a transaction.
    con.execute("BEGIN")
    rec_idx = 0
    # rec_buf is actually a flat list — we can't tell which recs belong to which msg
    # without tracking. This is handled correctly because _flush is called with a
    # fresh rec_buf each batch, and we recompute below.
    for row in msg_buf:
        cur = con.execute(
            "INSERT INTO messages "
            "(pst_source_id, folder_id, message_id, in_reply_to, subject, "
            " sender_name, sender_addr, sent_date, received_date, body_plain, body_html, source_file) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            row,
        )
        # rec_buf items don't carry a msg_id; we batched them alongside msg_buf
        # but lost the association. The correct approach is to carry them together.
        # We'll fix this by not using _flush for recipients separately.
    con.execute("COMMIT")


# ── revised import that keeps rec association ─────────────────────────────────

def import_messages_v2(out_dir, pst_source_id, folder_map, con, batch=200):
    out_dir = Path(out_dir)
    inserted = 0

    msg_rows = []   # (col tuple, [(kind,name,addr), ...])

    def flush(rows):
        nonlocal inserted
        con.execute("BEGIN")
        for (msg_row, recs) in rows:
            cur = con.execute(
                "INSERT INTO messages "
                "(pst_source_id, folder_id, message_id, in_reply_to, subject, "
                " sender_name, sender_addr, sent_date, received_date, body_plain, body_html, source_file) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                msg_row,
            )
            msg_db_id = cur.lastrowid
            for (kind, name, addr) in recs:
                con.execute(
                    "INSERT INTO recipients (message_id, kind, name, addr) VALUES (?,?,?,?)",
                    (msg_db_id, kind, name, addr),
                )
        con.execute("COMMIT")
        inserted += len(rows)

    for root, dirs, files in os.walk(out_dir):
        root_path = Path(root)
        folder_id = folder_map.get(str(root_path))

        for fname in sorted(files):
            fpath = root_path / fname
            # Include numbered files (readpst default) and .eml files
            if "." in fname and not fname.endswith(".eml"):
                continue  # skip .log, .size, .type, etc.

            try:
                raw = fpath.read_bytes()
                msg = email.message_from_bytes(raw)
            except Exception as e:
                continue

            # Check it looks like an email (has at least a From or Subject)
            if not msg.get("From") and not msg.get("Subject") and not msg.get("Date"):
                continue

            from_pairs = extract_addresses(msg.get("From", ""))
            sender_name = from_pairs[0][0] if from_pairs else None
            sender_addr = from_pairs[0][1] if from_pairs else None

            plain, html = get_body(msg)

            received_raw = msg.get("Received", "")
            received_date = None
            if received_raw:
                last_part = received_raw.split(";")[-1].strip()
                received_date = parse_date(last_part)

            msg_row = (
                pst_source_id,
                folder_id,
                decode_header(msg.get("Message-ID", "")) or None,
                decode_header(msg.get("In-Reply-To", "")) or None,
                decode_header(msg.get("Subject", "")) or None,
                sender_name or None,
                sender_addr or None,
                parse_date(msg.get("Date", "")),
                received_date,
                plain,
                html,
                str(fpath),
            )

            recs = []
            for kind, header in [("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")]:
                for name, addr in extract_addresses(msg.get(header, "")):
                    recs.append((kind, name or None, addr or None))

            msg_rows.append((msg_row, recs))

            if len(msg_rows) >= batch:
                flush(msg_rows)
                msg_rows = []
                print(f"    … {inserted:,} messages imported", end="\r", flush=True)

    if msg_rows:
        flush(msg_rows)
    print(f"    … {inserted:,} messages imported")
    return inserted


# ── main ──────────────────────────────────────────────────────────────────────

def process_pst(pst_path, db_path, keep_tmp=False):
    pst_path = Path(pst_path).resolve()
    if not pst_path.exists():
        print(f"ERROR: {pst_path} not found")
        return

    print(f"\n{'='*60}")
    print(f"Processing: {pst_path.name}")
    print(f"  Size: {pst_path.stat().st_size / 1e9:.2f} GB")

    con = init_db(db_path)

    # Register source
    cur = con.execute(
        "INSERT INTO pst_sources (filename, full_path, size_bytes, imported_at) VALUES (?,?,?,datetime('now'))",
        (pst_path.name, str(pst_path), pst_path.stat().st_size),
    )
    pst_source_id = cur.lastrowid
    con.commit()

    with tempfile.TemporaryDirectory(prefix="pst_extract_") as tmp:
        tmp_path = Path(tmp)
        print(f"  Extracting to temp dir …")
        t0 = time.time()
        rc = run_readpst(pst_path, tmp_path)
        print(f"  readpst done in {time.time()-t0:.0f}s (exit {rc})")

        print(f"  Building folder hierarchy …")
        folder_map = build_folder_tree(tmp_path, pst_source_id, con)
        print(f"  Folders found: {len(folder_map)}")

        print(f"  Importing messages …")
        t1 = time.time()
        n = import_messages_v2(tmp_path, pst_source_id, folder_map, con)
        print(f"  Import done in {time.time()-t1:.0f}s — {n:,} messages")

    con.close()
    print(f"  Done: {pst_path.name}")


def main():
    parser = argparse.ArgumentParser(description="Convert PST files to SQLite")
    parser.add_argument("pst_files", nargs="+", help="PST file paths")
    parser.add_argument("--db", required=True, help="Output SQLite database path")
    args = parser.parse_args()

    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Output DB: {db_path}")

    for pst_file in args.pst_files:
        process_pst(pst_file, db_path)

    # Summary
    con = sqlite3.connect(db_path)
    print("\n" + "="*60)
    print("SUMMARY")
    for row in con.execute("SELECT filename, size_bytes, imported_at FROM pst_sources"):
        print(f"  {row[0]}  ({row[1]/1e9:.2f} GB)  imported {row[2]}")
    msg_count = con.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    folder_count = con.execute("SELECT COUNT(*) FROM folders").fetchone()[0]
    rec_count = con.execute("SELECT COUNT(*) FROM recipients").fetchone()[0]
    print(f"  Messages:   {msg_count:,}")
    print(f"  Folders:    {folder_count:,}")
    print(f"  Recipients: {rec_count:,}")
    con.close()


if __name__ == "__main__":
    main()
