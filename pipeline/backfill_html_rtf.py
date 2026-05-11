#!/usr/bin/env python3
"""Backfill body_html and body_rtf for an existing pst_source by walking the PST
again. Non-destructive: only sets columns that are currently NULL.

Match (in order):
  1. Internet Message-ID (MAPI 0x1035) — preferred when present in DB and PST
  2. Composite (utc_minute_str, sender_addr_lower, subject[:80])
     - DB sent_date is parsed (tz-aware or naive) and normalized to UTC minute
     - PST client_submit_time is converted to UTC minute

Usage: python3 backfill_html_rtf.py <db> <pst_source_id> <pst_path>
"""
import sys, sqlite3, time
from datetime import datetime, timezone
import pypff

P_INTERNET_MESSAGE_ID = 0x1035
P_SENDER_EMAIL = 0x0C1F
P_SENT_REP_EMAIL = 0x0065
BODY_TRUNC = 200_000
COMMIT_BATCH = 500


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def get_property(item, entry_type):
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
                        return None
            except Exception:
                continue
    return None


def to_text(v):
    if v is None:
        return None
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", errors="replace")
        except Exception:
            return None
    return str(v)


def normalize_msgid(s):
    if not s:
        return None
    s = str(s).strip().strip("<>").strip()
    return s.lower() or None


def db_dt_to_utc_minute(s):
    """Parse DB sent_date and return YYYY-MM-DDTHH:MM string in UTC, or None."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M")


def pst_dt_to_utc_minute(dt):
    if dt is None:
        return None
    if not isinstance(dt, datetime):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M")


def main():
    if len(sys.argv) != 4:
        print("usage: backfill_html_rtf.py <db> <pst_source_id> <pst_path>", file=sys.stderr)
        sys.exit(2)
    db_path, src_id_s, pst_path = sys.argv[1:4]
    src_id = int(src_id_s)

    print(f"DB={db_path}")
    print(f"PST_SOURCE_ID={src_id}")
    print(f"PST={pst_path}")

    con = sqlite3.connect(db_path)
    cur = con.cursor()

    print("Loading DB row keys for source...")
    t0 = time.time()
    msgid_map = {}    # normalized message_id → row_id (single)
    comp_map = {}     # (utc_minute, sender_lc, subject[:80]) → [row_id, ...]
    nulls_html = 0
    nulls_rtf = 0
    total_rows = 0
    for row_id, msg_id, sent_date, sender_addr, subject, body_html, body_rtf in cur.execute(
        "SELECT id, message_id, sent_date, sender_addr, subject, body_html, body_rtf "
        "FROM messages WHERE pst_source_id=?",
        (src_id,),
    ):
        total_rows += 1
        if body_html is None or body_html == "":
            nulls_html += 1
        if body_rtf is None or body_rtf == "":
            nulls_rtf += 1
        nm = normalize_msgid(msg_id)
        if nm:
            msgid_map[nm] = row_id
        utcm = db_dt_to_utc_minute(sent_date)
        sender_lc = (sender_addr or "").strip().lower()
        subj_t = (subject or "")[:80]
        if utcm or sender_lc or subj_t:
            key = (utcm or "", sender_lc, subj_t)
            comp_map.setdefault(key, []).append(row_id)
    print(
        f"  rows={total_rows}  with_msgid={len(msgid_map)}  unique_composite={len(comp_map)}  "
        f"null_html={nulls_html}  null_rtf={nulls_rtf}  ({time.time()-t0:.0f}s)"
    )

    print("Opening PST...")
    t0 = time.time()
    pff = pypff.file()
    pff.open(pst_path)
    print(f"  opened in {time.time()-t0:.0f}s")

    counters = {
        "pst_msgs": 0,
        "no_body_to_offer": 0,
        "matched_msgid": 0,
        "matched_comp": 0,
        "comp_collision": 0,
        "unmatched": 0,
        "html_filled": 0,
        "rtf_filled": 0,
        "html_already_present": 0,
        "rtf_already_present": 0,
    }
    pending = 0
    t0 = time.time()

    def update_row(row_id, html, rtf):
        nonlocal pending
        cur.execute("SELECT body_html, body_rtf FROM messages WHERE id=?", (row_id,))
        cur_html, cur_rtf = cur.fetchone()
        will_html = html if (html and (cur_html is None or cur_html == "")) else None
        will_rtf  = rtf  if (rtf  and (cur_rtf  is None or cur_rtf  == "")) else None
        if will_html is None and will_rtf is None:
            if html and cur_html: counters["html_already_present"] += 1
            if rtf and cur_rtf:   counters["rtf_already_present"]  += 1
            return False
        if will_html is not None:
            cur.execute("UPDATE messages SET body_html=? WHERE id=?", (will_html[:BODY_TRUNC], row_id))
            counters["html_filled"] += 1
        if will_rtf is not None:
            cur.execute("UPDATE messages SET body_rtf=? WHERE id=?", (will_rtf[:BODY_TRUNC], row_id))
            counters["rtf_filled"] += 1
        pending += 1
        return True

    def walk(folder):
        nonlocal pending
        try: n_msgs = folder.get_number_of_sub_messages()
        except Exception: n_msgs = 0
        for i in range(n_msgs):
            try:
                m = folder.get_sub_message(i)
                counters["pst_msgs"] += 1

                html = to_text(safe(lambda: m.html_body, None))
                rtf  = to_text(safe(lambda: m.rtf_body, None))

                if not html and not rtf:
                    counters["no_body_to_offer"] += 1
                    continue

                row_id = None
                pst_msgid = normalize_msgid(get_property(m, P_INTERNET_MESSAGE_ID))
                if pst_msgid and pst_msgid in msgid_map:
                    row_id = msgid_map[pst_msgid]
                    counters["matched_msgid"] += 1
                else:
                    cst = safe(lambda: m.client_submit_time, None)
                    utcm = pst_dt_to_utc_minute(cst) or ""
                    sender_addr = (
                        to_text(get_property(m, P_SENDER_EMAIL))
                        or to_text(get_property(m, P_SENT_REP_EMAIL))
                        or ""
                    )
                    sender_lc = sender_addr.strip().lower()
                    subject = to_text(safe(lambda: m.subject, None)) or ""
                    subj_t = subject[:80]
                    key = (utcm, sender_lc, subj_t)
                    cands = comp_map.get(key)
                    if cands and len(cands) == 1:
                        row_id = cands[0]
                        counters["matched_comp"] += 1
                    elif cands and len(cands) > 1:
                        counters["comp_collision"] += 1
                    else:
                        counters["unmatched"] += 1

                if row_id is not None:
                    update_row(row_id, html, rtf)
                    if pending >= COMMIT_BATCH:
                        con.commit()
                        pending = 0
                        el = time.time() - t0
                        rate = counters["pst_msgs"] / max(el, 1)
                        print(
                            f"  pst_msgs={counters['pst_msgs']} html_filled={counters['html_filled']} "
                            f"rtf_filled={counters['rtf_filled']} matched_msgid={counters['matched_msgid']} "
                            f"matched_comp={counters['matched_comp']} unmatched={counters['unmatched']} "
                            f"coll={counters['comp_collision']} elapsed={el:.0f}s rate={rate:.0f}/s",
                            flush=True,
                        )
            except Exception:
                pass

        try: ns = folder.get_number_of_sub_folders()
        except Exception: ns = 0
        for i in range(ns):
            try:
                walk(folder.get_sub_folder(i))
            except Exception:
                pass

    walk(pff.get_root_folder())
    con.commit()

    el = time.time() - t0
    print()
    print(f"=== DONE in {el:.0f}s ===")
    for k, v in counters.items():
        print(f"  {k}={v}")
    pff.close()
    con.close()


if __name__ == "__main__":
    main()
