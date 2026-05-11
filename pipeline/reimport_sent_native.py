#!/usr/bin/env python3
"""
Re-import sent folder emails from PST files directly using pypff (MAPI-level).
For each sent message:
  - Gets display_to from PR_DISPLAY_TO (0x0e04)
  - If display_to is an email → use it directly
  - If display_to is a name-only → search plain-text body for 'From: Name <email>'
    in the quoted reply chain to recover the recipient SMTP address

Usage: python3 reimport_sent_native.py <db_path> <pst_path> <pst_source_id>
"""
import sys, re, sqlite3, pypff
from datetime import datetime, timezone

DB_PATH       = sys.argv[1]
PST_PATH      = sys.argv[2]
PST_SOURCE_ID = int(sys.argv[3])

# Regex: match From: Name <email> in quoted reply text
FROM_RE  = re.compile(r'From:\s+[^\n]*?<([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>', re.IGNORECASE)
EMAIL_RE = re.compile(r'^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$')

OWNER_DOMAINS: set[str] = set()  # TEMPLATE: populate with the set of email domains you control (or load from a file / me_addresses table)
def is_owner_addr(addr):
    if not addr: return False
    a = addr.lower().strip()
    domain = a.split('@')[-1] if '@' in a else ''
    return domain in OWNER_DOMAINS

def get_mapi_str(rs, entry_type):
    for i in range(rs.number_of_entries):
        entry = rs.get_entry(i)
        if entry.entry_type == entry_type:
            try: return entry.data_as_string or ''
            except: return ''
    return ''

def get_body_text(rs):
    for etype in (0x3fd9, 0x6619, 0x1000):  # plain text variants
        val = get_mapi_str(rs, etype)
        if val and len(val) > 10:
            return val
    return ''

def extract_recipient_email(display_to, body_text):
    """
    Returns (name, addr) for the recipient.
    If display_to contains an @, it's already an email.
    Otherwise search the quoted reply body for a matching From: <email>.
    """
    dt = display_to.strip().strip("'\"")

    if '@' in dt:
        return (None, dt.lower())

    # Name-only: search body for From: lines
    matches = FROM_RE.findall(body_text)
    # Filter out the owner's own addresses
    external = [m.lower() for m in matches if not is_owner_addr(m)]
    if external:
        # Best guess: first non-owner email found in the body
        return (dt or None, external[0])

    # No email found — store name only
    return (dt or None, None)

def find_sent_folders(folder, path=''):
    results = []
    for i in range(folder.number_of_sub_folders):
        sf = folder.get_sub_folder(i)
        name = sf.name or ''
        fpath = f"{path}/{name}" if path else name
        if 'sent' in name.lower():
            results.append((fpath, sf))
        results.extend(find_sent_folders(sf, fpath))
    return results

# ── Open PST ──────────────────────────────────────────────────────────────────
pst = pypff.file()
pst.open(PST_PATH)
root = pst.get_root_folder()

sent_folders = find_sent_folders(root)
print(f"Found sent folders: {[p for p, _ in sent_folders]}")

# ── Connect to DB ─────────────────────────────────────────────────────────────
con = sqlite3.connect(DB_PATH)

# Get DB folder records for this source
db_folders = con.execute(
    "SELECT id, name, full_path FROM folders WHERE pst_source_id=?",
    (PST_SOURCE_ID,)
).fetchall()
print(f"DB folders for source {PST_SOURCE_ID}:")
for fid, fname, fpath in db_folders:
    print(f"  id={fid}  name={fname!r}  path={fpath!r}")

# Build name→folder_id map
name_to_folder_id = {fname.lower(): fid for fid, fname, fpath in db_folders}

# ── Process each sent folder ──────────────────────────────────────────────────
total_inserted = total_skipped = total_name_only = 0

for folder_path, pst_folder in sent_folders:
    folder_name = pst_folder.name or ''
    folder_id = name_to_folder_id.get(folder_name.lower())
    if folder_id is None:
        print(f"WARNING: No DB folder for '{folder_name}' — skipping")
        continue

    n_msgs = pst_folder.number_of_sub_messages
    print(f"\nProcessing '{folder_path}' ({n_msgs} messages) → folder_id={folder_id}")

    # Delete existing messages in this folder
    old = con.execute("SELECT COUNT(*) FROM messages WHERE folder_id=?", (folder_id,)).fetchone()[0]
    print(f"  Deleting {old} existing messages")
    con.execute("DELETE FROM recipients WHERE message_id IN (SELECT id FROM messages WHERE folder_id=?)", (folder_id,))
    con.execute("DELETE FROM messages WHERE folder_id=?", (folder_id,))
    con.commit()

    inserted = skipped = name_only = 0
    con.execute("BEGIN")

    for i in range(n_msgs):
        msg = pst_folder.get_sub_message(i)
        rs  = msg.get_record_set(0)

        # Core fields
        subject    = (msg.subject or '').lstrip('\x01\x05')
        sender_name = msg.sender_name or ''
        display_to  = get_mapi_str(rs, 0x0e04)   # PR_DISPLAY_TO
        display_cc  = get_mapi_str(rs, 0x0e03)   # PR_DISPLAY_CC
        sender_addr = get_mapi_str(rs, 0x0065)   # PR_SENT_REPRESENTING_EMAIL_ADDRESS
        if not sender_addr:
            sender_addr = get_mapi_str(rs, 0x0c1f)  # PR_SENDER_EMAIL_ADDRESS
        msg_id      = get_mapi_str(rs, 0x1035)   # PR_INTERNET_MESSAGE_ID
        in_reply_to = get_mapi_str(rs, 0x1042)   # PR_IN_REPLY_TO_ID

        # Date
        sent_date = None
        try:
            t = msg.client_submit_time
            if t:
                sent_date = t.isoformat()
        except:
            pass

        # Body for email extraction
        body_text = get_body_text(rs)

        # Parse recipients
        recips = []
        for kind, display in [('to', display_to), ('cc', display_cc)]:
            if not display or display.strip() in ('', "'"):
                continue
            # Handle semicolon-separated multiple recipients
            parts = [p.strip().strip("'\"") for p in re.split(r';|,', display) if p.strip()]
            for part in parts:
                name, addr = extract_recipient_email(part, body_text)
                if addr and is_owner_addr(addr):
                    continue
                recips.append((kind, name, addr))
                if addr is None:
                    name_only += 1

        if not recips:
            skipped += 1
            continue

        cur = con.execute("""
            INSERT INTO messages
            (pst_source_id, folder_id, message_id, in_reply_to, subject,
             sender_name, sender_addr, sent_date, received_date,
             body_plain, body_html, source_file)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            PST_SOURCE_ID, folder_id,
            msg_id.strip('<>') or None,
            in_reply_to.strip('<>') or None,
            subject or None,
            sender_name or None,
            sender_addr.lower() or None,
            sent_date, sent_date,
            body_text[:10000] if body_text else None,
            None,
            PST_PATH
        ))
        msg_db_id = cur.lastrowid

        for kind, name, addr in recips:
            con.execute(
                "INSERT INTO recipients (message_id, kind, name, addr) VALUES (?,?,?,?)",
                (msg_db_id, kind, name or None, addr or None)
            )
        inserted += 1

    con.execute("COMMIT")
    total_inserted += inserted
    total_skipped  += skipped
    total_name_only += name_only
    print(f"  Inserted: {inserted}  Skipped: {skipped}  Name-only (no email found): {name_only}")

print(f"\n=== TOTAL: Inserted={total_inserted}  Skipped={total_skipped}  Name-only={total_name_only} ===")

# Spot-check
print("\nSample recipients:")
rows = con.execute("""
    SELECT r.kind, coalesce(r.name,''), coalesce(r.addr,'[name only]'), substr(m.subject,1,50)
    FROM recipients r
    JOIN messages m ON m.id=r.message_id
    JOIN folders f ON f.id=m.folder_id
    WHERE f.pst_source_id=? AND lower(f.name) IN ('sent items','sent mail','sent')
    LIMIT 25
""", (PST_SOURCE_ID,)).fetchall()
for kind, name, addr, subj in rows:
    print(f"  {kind}  {name:30s}  {addr:40s}  {subj}")

pst.close()
con.close()
