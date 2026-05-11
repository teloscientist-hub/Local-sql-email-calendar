#!/usr/bin/env python3
"""
Fill in addr for recipients where addr IS NULL but name IS NOT NULL.
Uses contact_lookup.json (name → list of emails).
For names with multiple emails, picks the best one:
  - Prefer personal/direct email (not admin@, support@, noreply@, hubspot, etc.)
  - Prefer the most-frequently-seen sender address in the DB
"""
import sqlite3, json, sys, re
from collections import Counter

DB_PATH      = sys.argv[1]
LOOKUP_PATH  = sys.argv[2]

BULK_PREFIXES = ('noreply','no-reply','admin@','support@','info@','newsletter',
                 'notification','automated','mailer','bounce','unsubscribe',
                 'marketing','billing','help@','team@','contact@','service@',
                 'invitations@','invitationteam@','community@','prezi@','echosign',
                 'yahoogroups','notifybf','hubspot')

def is_bulk(addr):
    a = addr.lower()
    return any(a.startswith(p) or p in a for p in BULK_PREFIXES)

def normalize(name):
    return re.sub(r'\s+', ' ', (name or '').lower().strip().strip("'\""))

with open(LOOKUP_PATH) as f:
    lookup = json.load(f)

con = sqlite3.connect(DB_PATH)

# Build frequency table: addr → count of times seen as sender in DB
freq = {}
rows = con.execute("""
    SELECT lower(sender_addr), COUNT(*) FROM messages
    WHERE sender_addr IS NOT NULL AND sender_addr LIKE '%@%'
    GROUP BY lower(sender_addr)
""").fetchall()
for addr, cnt in rows:
    freq[addr] = cnt

def best_email(candidates):
    """Pick the best email from a list of candidates."""
    # Filter obvious bulk
    personal = [e for e in candidates if not is_bulk(e)]
    pool = personal if personal else candidates
    # Pick by highest frequency in DB (most-seen sender)
    return max(pool, key=lambda e: freq.get(e, 0))

# Find all name-only recipients
name_only = con.execute("""
    SELECT id, name FROM recipients
    WHERE addr IS NULL AND name IS NOT NULL AND name != ''
""").fetchall()

print(f"Name-only recipients to resolve: {len(name_only)}")

updated = 0
still_missing = 0
multi_match = 0

con.execute("BEGIN")
for rec_id, name in name_only:
    norm = normalize(name)
    candidates = lookup.get(norm, [])

    # Also try parts of the name
    if not candidates:
        parts = norm.split()
        if len(parts) >= 2:
            candidates = lookup.get(f"{parts[0]} {parts[-1]}", [])
        if not candidates and parts:
            candidates = lookup.get(parts[0], [])

    if not candidates:
        still_missing += 1
        continue

    if len(candidates) > 1:
        multi_match += 1

    addr = best_email(candidates)
    con.execute("UPDATE recipients SET addr=? WHERE id=?", (addr, rec_id))
    updated += 1

con.execute("COMMIT")

print(f"Resolved:      {updated}")
print(f"Multi-match:   {multi_match} (picked best by frequency)")
print(f"Still missing: {still_missing}")

# Show sample resolved
print("\nSample resolved (first 20):")
rows = con.execute("""
    SELECT r.name, r.addr, substr(m.subject,1,45)
    FROM recipients r
    JOIN messages m ON m.id=r.message_id
    WHERE r.addr IS NOT NULL AND r.name IS NOT NULL
    ORDER BY r.id DESC LIMIT 20
""").fetchall()
for name, addr, subj in rows:
    print(f"  {name:30s} → {addr:35s}  {subj}")

con.close()
