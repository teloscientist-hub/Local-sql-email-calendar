#!/usr/bin/env python3
"""
Build a name→email lookup from:
1. Contacts folders in PST files (named MAPI properties 0x8027/8047/8067)
2. Received messages (sender_name → sender_addr)

Filters out the owner's own addresses from the values.
"""
import pypff, sys, json, re, sqlite3
from collections import defaultdict

PST_PATHS = sys.argv[1:-2]
DB_PATH   = sys.argv[-2]
OUT_PATH  = sys.argv[-1]

EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}')

OWNER_DOMAINS: set[str] = set()  # TEMPLATE: populate with the set of email domains you control (or load from a file / me_addresses table)
OWNER_ADDRS: set[str] = set()  # TEMPLATE: populate with the set of YOUR sending email addresses (or load from a file / me_addresses table)
# Named MAPI properties for Email1/2/3 address in contacts
# Explicitly EXCLUDING 0x0065 (sender addr) and 0x0c1f (sender addr)
CONTACT_EMAIL_PROPS = {0x8027, 0x8047, 0x8067, 0x808a, 0x808b, 0x806a, 0x806b,
                       0x3003, 0x39fe}

def is_owner_addr(addr):
    if not addr: return True
    a = addr.lower().strip()
    if a in OWNER_ADDRS: return True
    domain = a.split('@')[-1] if '@' in a else ''
    return domain in OWNER_DOMAINS

def normalize(name):
    return re.sub(r'\s+', ' ', (name or '').lower().strip().strip("'\""))

def find_folder(folder, target):
    for i in range(folder.number_of_sub_folders):
        sf = folder.get_sub_folder(i)
        if (sf.name or '').lower() == target.lower():
            return sf
        r = find_folder(sf, target)
        if r: return r
    return None

lookup = defaultdict(set)  # normalized_name → set of emails

# ── Phase 1: Contacts folders ─────────────────────────────────────────────────
for pst_path in PST_PATHS:
    print(f"Opening {pst_path}...")
    pst = pypff.file()
    pst.open(pst_path)
    root = pst.get_root_folder()
    contacts_folder = find_folder(root, 'Contacts')
    if not contacts_folder:
        pst.close()
        continue

    n = contacts_folder.number_of_sub_messages
    print(f"  {n} contacts")
    found = 0
    for i in range(n):
        try:
            msg = contacts_folder.get_sub_message(i)
            rs  = msg.get_record_set(0)
            name = ''
            emails = set()
            for e in range(rs.number_of_entries):
                entry = rs.get_entry(e)
                try:
                    val = str(entry.data_as_string or '')
                    if not val: continue
                    if entry.entry_type == 0x3001:
                        name = val
                    elif entry.entry_type in CONTACT_EMAIL_PROPS:
                        for m in EMAIL_RE.findall(val):
                            if not is_owner_addr(m) and 'microsoft' not in m.lower():
                                emails.add(m.lower())
                except: pass

            if name and emails:
                norm = normalize(name)
                lookup[norm].update(emails)
                parts = norm.split()
                if len(parts) >= 2:
                    lookup[f"{parts[0]} {parts[-1]}"].update(emails)
                found += 1
        except: pass
    print(f"  Contacts with emails: {found}")
    pst.close()

print(f"Contacts lookup: {len(lookup)} names")

# ── Phase 2: Received messages (sender_name → sender_addr) ────────────────────
print("Building from received message senders...")
con = sqlite3.connect(DB_PATH)
# Build owner-domain exclusion clauses dynamically. Empty OWNER_DOMAINS = no
# domain filter — is_owner_addr() below is still the authoritative check.
_owner_domain_clauses = "\n      ".join(
    f"AND lower(sender_addr) NOT LIKE '%@{d}'" for d in sorted(OWNER_DOMAINS)
)
rows = con.execute(f"""
    SELECT lower(trim(sender_name)), lower(trim(sender_addr))
    FROM messages
    WHERE sender_name IS NOT NULL AND sender_name != ''
      AND sender_addr IS NOT NULL AND sender_addr LIKE '%@%'
      {_owner_domain_clauses}
    GROUP BY lower(sender_name), lower(sender_addr)
    HAVING COUNT(*) >= 1
""").fetchall()
con.close()

for sname, saddr in rows:
    if not sname or not saddr or is_owner_addr(saddr):
        continue
    norm = normalize(sname)
    if norm:
        lookup[norm].add(saddr)
        parts = norm.split()
        if len(parts) >= 2:
            lookup[parts[0]].add(saddr)
            lookup[f"{parts[0]} {parts[-1]}"].add(saddr)

print(f"After sender lookup: {len(lookup)} names total")

out = {k: sorted(v) for k, v in lookup.items() if v}
with open(OUT_PATH, 'w') as f:
    json.dump(out, f, indent=2)
print(f"Written: {len(out)} entries → {OUT_PATH}")
