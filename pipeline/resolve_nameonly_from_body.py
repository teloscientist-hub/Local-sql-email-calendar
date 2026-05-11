#!/usr/bin/env python3
"""
Extract email addresses for name-only recipients by scanning the quoted reply
body for From:/To: lines that contain the recipient name and an email address.

Strategies (in order of confidence):
1. `From: Display Name [mailto:email]` or `From: Display Name <email>`
2. `To: 'Display Name' <email>` in quoted headers
3. Any email in body that matches the name closely
"""
import sqlite3, re, sys
from difflib import SequenceMatcher

DB_PATH = sys.argv[1]

EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}')

# Patterns for From:/To: lines with email
FROM_MAILTO = re.compile(
    r'From:\s+(.+?)\s+\[mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\]',
    re.IGNORECASE
)
FROM_ANGLE = re.compile(
    r'From:\s+(.+?)\s+<([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>',
    re.IGNORECASE
)
TO_ANGLE = re.compile(
    r'(?:To|Cc):\s+[\'"]?(.+?)[\'"]?\s+<([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>',
    re.IGNORECASE
)

OWNER_DOMAINS: set[str] = set()  # TEMPLATE: populate with the set of email domains you control (or load from a file / me_addresses table)
OWNER_ADDRS: set[str] = set()  # TEMPLATE: populate with the set of YOUR sending email addresses (or load from a file / me_addresses table)
def is_owner_addr(addr):
    if not addr: return True
    a = addr.lower().strip()
    if a in OWNER_ADDRS: return True
    domain = a.split('@')[-1] if '@' in a else ''
    return domain in OWNER_DOMAINS

def normalize(s):
    return re.sub(r'\s+', ' ', (s or '').lower().strip().strip("'\".,"))

def name_similarity(a, b):
    a, b = normalize(a), normalize(b)
    if not a or not b: return 0.0
    if a == b: return 1.0
    # Check if all words of the shorter name appear in the longer
    a_parts = set(a.split())
    b_parts = set(b.split())
    if a_parts & b_parts:
        overlap = len(a_parts & b_parts) / max(len(a_parts), len(b_parts))
        if overlap >= 0.5:
            return overlap
    return SequenceMatcher(None, a, b).ratio()

def extract_candidates(body, recipient_name):
    """
    Returns list of (email, confidence, method) for emails found near the recipient name.
    """
    candidates = []
    norm_name = normalize(recipient_name)

    # Strategy 1: From: Name [mailto:email]
    for m in FROM_MAILTO.finditer(body):
        display, email = m.group(1).strip(), m.group(2).strip()
        if is_owner_addr(email): continue
        sim = name_similarity(recipient_name, display)
        if sim >= 0.4:
            candidates.append((email.lower(), sim, 'from_mailto'))

    # Strategy 2: From: Name <email>
    for m in FROM_ANGLE.finditer(body):
        display, email = m.group(1).strip(), m.group(2).strip()
        if is_owner_addr(email): continue
        sim = name_similarity(recipient_name, display)
        if sim >= 0.4:
            candidates.append((email.lower(), sim, 'from_angle'))

    # Strategy 3: To:/Cc: Name <email>
    for m in TO_ANGLE.finditer(body):
        display, email = m.group(1).strip(), m.group(2).strip()
        if is_owner_addr(email): continue
        sim = name_similarity(recipient_name, display)
        if sim >= 0.4:
            candidates.append((email.lower(), sim, 'to_angle'))

    # Strategy 4: Any email in body where the name appears within 200 chars
    for m in EMAIL_RE.finditer(body):
        email = m.group(0)
        if is_owner_addr(email): continue
        start = max(0, m.start() - 200)
        end = min(len(body), m.end() + 200)
        context = body[start:end]
        if norm_name and norm_name in normalize(context):
            candidates.append((email.lower(), 0.3, 'context'))

    return candidates

con = sqlite3.connect(DB_PATH)

# Get all name-only recipients with body text
rows = con.execute("""
    SELECT r.id, r.name, r.message_id, coalesce(m.body_plain, '')
    FROM recipients r
    JOIN messages m ON m.id = r.message_id
    WHERE r.name IS NOT NULL AND r.name != ''
      AND (r.addr IS NULL OR r.addr NOT LIKE '%@%')
      AND m.body_plain IS NOT NULL AND length(m.body_plain) > 50
""").fetchall()

print(f"Name-only recipients with body text: {len(rows)}")

resolved = {}   # rec_id -> (email, confidence, method)
multi = 0

for rec_id, name, msg_id, body in rows:
    candidates = extract_candidates(body, name)
    if not candidates:
        continue

    # Pick highest confidence
    candidates.sort(key=lambda x: -x[1])
    best_email, best_conf, best_method = candidates[0]

    if len(set(c[0] for c in candidates)) > 1:
        multi += 1

    resolved[rec_id] = (best_email, best_conf, best_method, name)

print(f"Resolved: {len(resolved)}")
print(f"With multiple candidates: {multi}")

# Apply updates
con.execute("BEGIN")
updated = 0
for rec_id, (email, conf, method, name) in resolved.items():
    con.execute("UPDATE recipients SET addr=? WHERE id=?", (email, rec_id))
    updated += 1
con.execute("COMMIT")

print(f"Updated {updated} recipient rows")

# Show sample
print("\nSample resolutions:")
sample = sorted(resolved.items(), key=lambda x: -x[1][1])[:30]
for rec_id, (email, conf, method, name) in sample:
    print(f"  {name:30s} → {email:40s}  [{method}, conf={conf:.2f}]")

# Final count
remaining = con.execute("""
    SELECT COUNT(*) FROM recipients
    WHERE name IS NOT NULL AND name != ''
      AND (addr IS NULL OR addr NOT LIKE '%@%')
""").fetchone()[0]
print(f"\nName-only remaining after fix: {remaining}")

con.close()
