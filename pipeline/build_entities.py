#!/usr/bin/env python3
"""
Build contact entity resolution tables.
Conservative approach: only link emails to a person when the link is specific.
"""
import sqlite3, json, sys, re
from collections import defaultdict

DB_PATH     = sys.argv[1]
LOOKUP_PATH = sys.argv[2]

def normalize(name):
    return re.sub(r'\s+', ' ', (name or '').lower().strip().strip("'\""))

OWNER_DOMAINS: set[str] = set()  # TEMPLATE: populate with the set of email domains you control (or load from a file / me_addresses table)
OWNER_ADDRS: set[str] = set()  # TEMPLATE: populate with the set of YOUR sending email addresses (or load from a file / me_addresses table)
OWNER_NAMES: set[str] = set()  # TEMPLATE: populate with the set of normalized name strings that should resolve to YOU (or load from a file / me_addresses table)
def is_owner_addr(addr):
    if not addr: return True
    a = addr.lower().strip()
    if a in OWNER_ADDRS: return True
    domain = a.split('@')[-1] if '@' in a else ''
    return domain in OWNER_DOMAINS

def is_owner_name(name):
    return normalize(name) in OWNER_NAMES

GENERIC_NAMES = {'the team','the company','support','admin','no name','unknown',
                 'hi','hello','hey','dear','* *','team','staff','office'}

def is_generic(name):
    n = normalize(name)
    return n in GENERIC_NAMES or len(n) < 3

con = sqlite3.connect(DB_PATH)

# ── Create tables ─────────────────────────────────────────────────────────────
con.executescript("""
DROP TABLE IF EXISTS contact_email_map;
DROP TABLE IF EXISTS contact_entities;

CREATE TABLE contact_entities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name  TEXT NOT NULL,
    canonical_email TEXT,
    notes           TEXT
);
CREATE TABLE contact_email_map (
    email              TEXT PRIMARY KEY,
    contact_entity_id  INTEGER NOT NULL REFERENCES contact_entities(id)
);
CREATE INDEX idx_cem_entity ON contact_email_map(contact_entity_id);
""")
con.commit()

# ── Source 1: Direct sender_name → sender_addr from received messages ─────────
# Only exact full-name matches (not first-name-only)
print("Building from received messages...")
rows = con.execute("""
    SELECT lower(trim(sender_name)), lower(trim(sender_addr)), COUNT(*) as cnt
    FROM messages
    WHERE sender_name IS NOT NULL AND length(trim(sender_name)) > 3
      AND sender_addr IS NOT NULL AND sender_addr LIKE '%@%'
      AND instr(lower(sender_addr), '@') > 1
    GROUP BY lower(trim(sender_name)), lower(trim(sender_addr))
""").fetchall()

# name → {email: frequency}
name_emails = defaultdict(lambda: defaultdict(int))
for sname, saddr, cnt in rows:
    if is_owner_addr(saddr) or is_owner_name(sname) or is_generic(sname):
        continue
    # Only full names (at least 2 words with length > 2 each) OR single long names
    parts = sname.split()
    if len(parts) >= 2 and all(len(p) > 1 for p in parts):
        name_emails[sname][saddr] += cnt
    elif len(parts) == 1 and len(sname) > 5:
        name_emails[sname][saddr] += cnt  # single-word company/brand names

print(f"  Unique sender names: {len(name_emails)}")

# ── Source 2: Contacts folder data from lookup JSON ───────────────────────────
print("Loading contacts lookup...")
with open(LOOKUP_PATH) as f:
    lookup = json.load(f)

# Add contacts-sourced email→name links (these are higher confidence)
# We'll mark them as "contacts" source
contacts_data = {}  # name → set of emails
for name, emails in lookup.items():
    parts = name.split()
    if len(parts) < 2: continue
    if is_owner_name(name) or is_generic(name): continue
    clean = [e for e in emails if not is_owner_addr(e) and '@' in e]
    if clean:
        contacts_data[name] = set(clean)

print(f"  Contacts entries: {len(contacts_data)}")

# ── Merge contacts into name_emails (contacts take priority) ──────────────────
for name, emails in contacts_data.items():
    for e in emails:
        name_emails[name][e] = name_emails[name].get(e, 0) + 1000  # high weight

# ── Build entity groups: email→name (invert, pick best name per email) ────────
# For each email, the "canonical" name is the full name with most messages
email_to_name = {}  # email → canonical name
for name, email_freq in name_emails.items():
    total = sum(email_freq.values())
    for email, freq in email_freq.items():
    	# Only assign if this name has the most messages for this email
        current = email_to_name.get(email)
        if current is None:
            email_to_name[email] = (name, freq)
        else:
            if freq > current[1]:
                email_to_name[email] = (name, freq)

# Flip: name → set of emails
entity_emails = defaultdict(set)
for email, (name, freq) in email_to_name.items():
    entity_emails[name].add(email)

print(f"Entity candidates: {len(entity_emails)}")

# ── Insert into DB ─────────────────────────────────────────────────────────────
entity_id_map = {}  # canonical_name → db_id

con.execute("BEGIN")
inserted_entities = 0
inserted_emails = 0

for name, emails in sorted(entity_emails.items()):
    clean = sorted(e for e in emails if not is_owner_addr(e))
    if not clean:
        continue

    # Canonical email: prefer personal (not bulk patterns)
    BULK = ('noreply','no-reply','admin@','support@','newsletter','notification',
            'automated','mailer','bounce','hubspot','echosign')
    personal = [e for e in clean if not any(b in e for b in BULK)]
    canon_email = personal[0] if personal else clean[0]

    cur = con.execute(
        "INSERT INTO contact_entities (canonical_name, canonical_email) VALUES (?,?)",
        (name, canon_email)
    )
    eid = cur.lastrowid
    entity_id_map[name] = eid
    inserted_entities += 1

    for email in clean:
        try:
            con.execute(
                "INSERT OR IGNORE INTO contact_email_map (email, contact_entity_id) VALUES (?,?)",
                (email, eid)
            )
            inserted_emails += 1
        except:
            pass

con.execute("COMMIT")

print(f"\nEntities created:       {inserted_entities:,}")
print(f"Email mappings:         {inserted_emails:,}")

multi = con.execute("""
    SELECT COUNT(*) FROM (
        SELECT contact_entity_id FROM contact_email_map
        GROUP BY contact_entity_id HAVING COUNT(*) > 1
    )
""").fetchone()[0]
print(f"Entities with >1 email: {multi:,}")

# ── Update name-only recipients ────────────────────────────────────────────────
name_only = con.execute("""
    SELECT id, name FROM recipients
    WHERE (addr IS NULL OR addr = '') AND name IS NOT NULL AND name != ''
""").fetchall()
print(f"\nResolving {len(name_only)} name-only recipients...")

updated = 0
con.execute("BEGIN")
for rec_id, name in name_only:
    norm = normalize(name)
    eid = entity_id_map.get(norm)
    if not eid:
        # try matching on normalized parts
        parts = norm.split()
        if len(parts) >= 2:
            eid = entity_id_map.get(f"{parts[0]} {parts[-1]}")
    if eid:
        row = con.execute(
            "SELECT canonical_email FROM contact_entities WHERE id=?", (eid,)
        ).fetchone()
        if row and row[0]:
            con.execute("UPDATE recipients SET addr=? WHERE id=?", (row[0], rec_id))
            updated += 1
con.execute("COMMIT")
print(f"Resolved: {updated}")

# ── Sample multi-email entities ────────────────────────────────────────────────
print("\nSample entities with multiple emails (top 25):")
rows = con.execute("""
    SELECT ce.canonical_name, COUNT(*) as cnt, GROUP_CONCAT(cem.email, ' | ') as emails
    FROM contact_entities ce
    JOIN contact_email_map cem ON cem.contact_entity_id = ce.id
    GROUP BY ce.id
    HAVING cnt > 1
    ORDER BY cnt DESC
    LIMIT 25
""").fetchall()
for name, cnt, emails in rows:
    print(f"  {name:30s} ({cnt}) {emails[:90]}")

con.close()
