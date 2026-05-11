#!/usr/bin/env python3
"""Tier 1 ingest: pypff folder walk into warehouse.sqlite (live schema).

Usage: python3 01_ingest_pypff_walk.py /path/to/file.pst /path/to/warehouse.sqlite
"""
from __future__ import annotations

import os
import sys
import sqlite3
import time
from datetime import datetime
from email.parser import HeaderParser
from email.utils import getaddresses, parseaddr, parsedate_to_datetime

import pypff


BODY_TRUNC = 10000
COMMIT_BATCH = 1000

# MAPI property identifiers (from doc §4 Phase 2)
P_INTERNET_MESSAGE_ID = 0x1035
P_IN_REPLY_TO_ID = 0x1042
P_SENT_REP_EMAIL = 0x0065
P_SENDER_EMAIL = 0x0C1F
P_DISPLAY_TO = 0x0E04
P_DISPLAY_CC = 0x0E03
P_DISPLAY_BCC = 0x0E02


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def get_property(item, entry_type):
    """Scan record sets for the first entry of this type. Returns string or None."""
    try:
        n_rs = item.get_number_of_record_sets()
    except Exception:
        return None
    for i in range(n_rs):
        try:
            rs = item.get_record_set(i)
            n_e = rs.get_number_of_entries()
        except Exception:
            continue
        for j in range(n_e):
            try:
                e = rs.get_entry(j)
                if e.entry_type == entry_type:
                    try:
                        v = e.get_data_as_string()
                        if v:
                            return v
                    except Exception:
                        try:
                            return e.data
                        except Exception:
                            return None
            except Exception:
                continue
    return None


def ts(dt):
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)


def normalize_addr(s):
    if not s:
        return None
    s = str(s).strip().strip("<>").strip().lower()
    if "@" in s and 5 <= len(s) <= 255 and " " not in s:
        return s
    return None


def parse_addr_list(s):
    """Parse semicolon-separated 'Name <email>; ...' style. Returns list of (name, addr)."""
    if not s:
        return []
    out = []
    parts = []
    cur = ""
    in_quote = False
    in_angle = False
    for ch in s:
        if ch == '"':
            in_quote = not in_quote
            cur += ch
        elif ch == "<":
            in_angle = True
            cur += ch
        elif ch == ">":
            in_angle = False
            cur += ch
        elif ch in (";", ",") and not in_quote and not in_angle:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        parts.append(cur)
    for part in parts:
        part = part.strip().strip("'").strip()
        if not part:
            continue
        if "<" in part and ">" in part:
            try:
                name = part[: part.index("<")].strip().strip('"').strip("'").strip()
                addr = part[part.index("<") + 1 : part.index(">")].strip().lower()
            except Exception:
                name, addr = None, None
        elif "@" in part:
            name, addr = None, part.lower()
        else:
            name, addr = part.strip('"').strip("'").strip(), None
        out.append((name or None, addr or None))
    return out


def parse_headers(raw):
    if not raw:
        return None
    try:
        return HeaderParser().parsestr(raw)
    except Exception:
        return None


def main():
    if len(sys.argv) != 3:
        print("usage: 01_ingest_pypff_walk.py PST_PATH DB_PATH", file=sys.stderr)
        sys.exit(2)
    pst_path = sys.argv[1]
    db_path = sys.argv[2]

    print(f"opening: {pst_path}")
    t_open = time.time()
    pff = pypff.file()
    pff.open(pst_path)
    print(f"opened in {time.time() - t_open:.0f}s")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    cur = conn.cursor()

    fname = os.path.basename(pst_path)
    size = os.path.getsize(pst_path)
    cur.execute(
        "INSERT INTO pst_sources(filename, full_path, size_bytes, imported_at) "
        "VALUES(?, ?, ?, ?)",
        (fname, pst_path, size, datetime.utcnow().isoformat(timespec="seconds")),
    )
    new_id = cur.lastrowid
    print(f"new pst_source_id = {new_id}")
    conn.commit()

    counters = {"inserted": 0, "skipped": 0, "folders": 0}
    t0 = time.time()

    def ingest_message(msg, folder_id):
        headers_str = safe(lambda: msg.transport_headers, None)
        hdrs = parse_headers(headers_str) if headers_str else None

        subject = safe(lambda: msg.subject, None)
        if not subject and hdrs is not None:
            subject = hdrs.get("Subject")

        sender_name = safe(lambda: msg.sender_name, None)
        if not sender_name and hdrs is not None:
            from_str = hdrs.get("From")
            if from_str:
                n, _ = parseaddr(from_str)
                sender_name = n or None

        sender_addr = get_property(msg, P_SENT_REP_EMAIL) or get_property(msg, P_SENDER_EMAIL)
        sender_addr = normalize_addr(sender_addr) if sender_addr else None
        if not sender_addr and hdrs is not None:
            from_str = hdrs.get("From")
            if from_str:
                _, a = parseaddr(from_str)
                sender_addr = normalize_addr(a)

        sent_date = ts(safe(lambda: msg.client_submit_time, None))
        received_date = ts(safe(lambda: msg.delivery_time, None))
        if not sent_date and hdrs is not None:
            d = hdrs.get("Date")
            if d:
                try:
                    sent_date = parsedate_to_datetime(d).isoformat()
                except Exception:
                    pass

        message_id = get_property(msg, P_INTERNET_MESSAGE_ID)
        if message_id:
            message_id = message_id.strip().strip("<>").strip()
        elif hdrs is not None:
            mid = hdrs.get("Message-ID")
            if mid:
                message_id = mid.strip().strip("<>").strip()

        in_reply_to = get_property(msg, P_IN_REPLY_TO_ID)
        if in_reply_to:
            in_reply_to = in_reply_to.strip().strip("<>").strip()
        elif hdrs is not None:
            irt = hdrs.get("In-Reply-To")
            if irt:
                in_reply_to = irt.strip().strip("<>").strip()

        body = safe(lambda: msg.plain_text_body, None)
        if isinstance(body, bytes):
            try:
                body = body.decode("utf-8", errors="replace")
            except Exception:
                body = None
        if body and len(body) > BODY_TRUNC:
            body = body[:BODY_TRUNC]

        cur.execute(
            "INSERT INTO messages("
            "pst_source_id, folder_id, message_id, in_reply_to, subject, "
            "sender_name, sender_addr, sent_date, received_date, body_plain, source_file) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                new_id, folder_id, message_id, in_reply_to, subject,
                sender_name, sender_addr, sent_date, received_date, body,
                fname,
            ),
        )
        msg_db_id = cur.lastrowid

        # Recipients
        if hdrs is not None and (hdrs.get("To") or hdrs.get("Cc") or hdrs.get("Bcc")):
            for kind, hdr in (("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")):
                val = hdrs.get(hdr)
                if val:
                    for name, addr in getaddresses([val]):
                        if name or addr:
                            cur.execute(
                                "INSERT INTO recipients(message_id, kind, name, addr) "
                                "VALUES(?, ?, ?, ?)",
                                (msg_db_id, kind, name or None,
                                 normalize_addr(addr) or (addr.lower() if addr else None)),
                            )
        else:
            for kind, prop in (("to", P_DISPLAY_TO), ("cc", P_DISPLAY_CC), ("bcc", P_DISPLAY_BCC)):
                val = get_property(msg, prop)
                for name, addr in parse_addr_list(val):
                    if name or addr:
                        cur.execute(
                            "INSERT INTO recipients(message_id, kind, name, addr) "
                            "VALUES(?, ?, ?, ?)",
                            (msg_db_id, kind, name, addr),
                        )

    def walk(folder, parent_folder_id, parent_path, depth):
        try:
            name = folder.get_name() or "_unnamed_"
        except Exception:
            name = "_unnamed_"
        full_path = f"{parent_path}/{name}" if parent_path else name
        cur.execute(
            "INSERT INTO folders(pst_source_id, parent_folder_id, name, full_path, depth) "
            "VALUES(?, ?, ?, ?, ?)",
            (new_id, parent_folder_id, name, full_path, depth),
        )
        folder_id = cur.lastrowid
        counters["folders"] += 1

        try:
            n_msgs = folder.get_number_of_sub_messages()
        except Exception:
            n_msgs = 0
        for i in range(n_msgs):
            try:
                msg = folder.get_sub_message(i)
                ingest_message(msg, folder_id)
                counters["inserted"] += 1
                if counters["inserted"] % COMMIT_BATCH == 0:
                    conn.commit()
                    el = time.time() - t0
                    rate = counters["inserted"] / max(el, 1)
                    print(
                        f"  inserted={counters['inserted']} skipped={counters['skipped']} "
                        f"folders={counters['folders']} elapsed={el:.0f}s rate={rate:.0f}/s",
                        flush=True,
                    )
            except Exception:
                counters["skipped"] += 1

        try:
            n_sub = folder.get_number_of_sub_folders()
        except Exception:
            n_sub = 0
        for i in range(n_sub):
            try:
                sub = folder.get_sub_folder(i)
                walk(sub, folder_id, full_path, depth + 1)
            except Exception:
                counters["skipped"] += 1

    root = pff.get_root_folder()
    walk(root, None, "", 0)
    conn.commit()

    el = time.time() - t0
    print(
        f"DONE: inserted={counters['inserted']} skipped={counters['skipped']} "
        f"folders={counters['folders']} elapsed={el:.0f}s pst_source_id={new_id}"
    )
    pff.close()
    conn.close()


if __name__ == "__main__":
    main()
