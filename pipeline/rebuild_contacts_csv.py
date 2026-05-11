#!/usr/bin/env python3
"""
Rebuild contacts_to_rate.csv using contact_entities + contact_email_map.
- Aggregates message counts across ALL email addresses per entity
- Preserves existing ratings from current CSV
- Filters out pure bulk/system entities
- Sorts: rated first (by score desc), unrated second (by score desc)
"""
import sqlite3, csv, sys, re
from collections import defaultdict

DB_PATH  = sys.argv[1]
CSV_IN   = sys.argv[2]
CSV_OUT  = sys.argv[3]

OWNER_DOMAINS: set[str] = set()  # TEMPLATE: populate with the set of email domains you control (or load from a file / me_addresses table)
OWNER_ADDRS: set[str] = set()  # TEMPLATE: populate with the set of YOUR sending email addresses (or load from a file / me_addresses table)
# SQL list literal built from OWNER_ADDRS (used in sent_count queries)
_OWNER_ADDRS_SQL = ",".join("'" + a + "'" for a in sorted(OWNER_ADDRS))

BULK_PATTERNS = ('noreply','no-reply','newsletter','notification','automated','mailer',
                 'bounce','unsubscribe','marketing','billing','help@','team@','contact@',
                 'service@','invitations@','invitationteam@','community@','prezi@',
                 'echosign','yahoogroups','notifybf','hubspot',
                 'postmaster','mailer-daemon','donotreply','do-not-reply','info@',
                 'support@','admin@','wordpress@','editor@','glitter@')

BULK_NAMES = {'twitter','alibaba.com','alibaba','wordpress','facebook','yahoo! groups notification',
              'pinterest','amazon.com','amazon.com payments','credit karma','kaiser permanente',
              'mail delivery system','mail delivery subsystem','godaddy','zillow',
              'ebay','wayfair','paypal','nextdoor','yelp','linkedin','instagram',
              'youtube','google','apple','microsoft','amazon','the team','support',
              'admin','noreply','no-reply','newsletter','mailchimp','constant contact',
              'sendgrid','mailgun','sparkpost'}

def is_bulk_email(addr):
    a = addr.lower()
    return any(p in a for p in BULK_PATTERNS)

def is_owner_addr(addr):
    if not addr: return True
    a = addr.lower().strip()
    if a in OWNER_ADDRS: return True
    domain = a.split('@')[-1] if '@' in a else ''
    return domain in OWNER_DOMAINS

def is_bulk_name(name):
    n = name.lower().strip()
    return n in BULK_NAMES or len(n) < 2

con = sqlite3.connect(DB_PATH)

print("Loading entity email map...")
# entity_id → {email set}
entity_emails = defaultdict(set)
email_to_entity = {}
rows = con.execute("SELECT email, contact_entity_id FROM contact_email_map").fetchall()
for email, eid in rows:
    if not is_owner_addr(email):
        entity_emails[eid].add(email)
        email_to_entity[email] = eid

# entity_id → canonical_name
entity_names = {}
rows = con.execute("SELECT id, canonical_name, canonical_email FROM contact_entities").fetchall()
for eid, name, canon_email in rows:
    entity_names[eid] = (name, canon_email)

print(f"  Entities: {len(entity_names)}, Email mappings: {len(email_to_entity)}")

# ── Count sent messages from owner to each entity ─────────────────────────────
print("Counting sent messages...")
# Messages where the owner is sender, recipient has an email in our entity map
sent_rows = con.execute(f"""
    SELECT lower(r.addr), MIN(substr(m.sent_date,1,4)), MAX(substr(m.sent_date,1,4))
    FROM recipients r
    JOIN messages m ON m.id = r.message_id
    WHERE r.addr IS NOT NULL AND r.addr LIKE '%@%'
      AND r.kind IN ('to','cc')
      AND lower(m.sender_addr) IN ({_OWNER_ADDRS_SQL})
    GROUP BY lower(r.addr)
""").fetchall()

entity_sent = defaultdict(int)
entity_sent_years = {}  # eid → (min_year, max_year)

# First just count by email, then aggregate to entity
email_sent_count = defaultdict(int)
email_sent_years = {}

# Need per-message counts, not just per-email
sent_count_rows = con.execute(f"""
    SELECT lower(r.addr), COUNT(*) as cnt,
           MIN(substr(m.sent_date,1,4)), MAX(substr(m.sent_date,1,4))
    FROM recipients r
    JOIN messages m ON m.id = r.message_id
    WHERE r.addr IS NOT NULL AND r.addr LIKE '%@%'
      AND r.kind IN ('to','cc')
      AND lower(m.sender_addr) IN ({_OWNER_ADDRS_SQL})
    GROUP BY lower(r.addr)
""").fetchall()

for email, cnt, yr_min, yr_max in sent_count_rows:
    email_sent_count[email] = cnt
    email_sent_years[email] = (yr_min, yr_max)

# ── Count received messages from each entity ──────────────────────────────────
print("Counting received messages...")
recv_count_rows = con.execute("""
    SELECT lower(sender_addr), COUNT(*) as cnt,
           MIN(substr(sent_date,1,4)), MAX(substr(sent_date,1,4))
    FROM messages
    WHERE sender_addr IS NOT NULL AND sender_addr LIKE '%@%'
    GROUP BY lower(sender_addr)
""").fetchall()

email_recv_count = defaultdict(int)
email_recv_years = {}
for email, cnt, yr_min, yr_max in recv_count_rows:
    email_recv_count[email] = cnt
    email_recv_years[email] = (yr_min, yr_max)

# ── Aggregate to entity level ─────────────────────────────────────────────────
print("Aggregating entity statistics...")

entity_stats = {}
for eid, emails in entity_emails.items():
    name, canon_email = entity_names.get(eid, ('', ''))

    # Skip bulk entities
    if is_bulk_name(name):
        continue

    # Get non-bulk emails
    personal_emails = [e for e in emails if not is_bulk_email(e) and not is_owner_addr(e)]
    all_emails = [e for e in emails if not is_owner_addr(e)]

    if not all_emails:
        continue

    # Aggregate counts across all emails
    sent_total = sum(email_sent_count.get(e, 0) for e in all_emails)
    recv_total = sum(email_recv_count.get(e, 0) for e in all_emails)

    # Skip if no meaningful interaction
    if sent_total == 0 and recv_total == 0:
        continue

    # Year range
    all_years = []
    for e in all_emails:
        if e in email_sent_years:
            all_years.extend([email_sent_years[e][0], email_sent_years[e][1]])
        if e in email_recv_years:
            all_years.extend([email_recv_years[e][0], email_recv_years[e][1]])
    valid_years = [y for y in all_years if y and y.isdigit() and 2000 <= int(y) <= 2030]
    first_year = min(valid_years) if valid_years else ''
    last_year = max(valid_years) if valid_years else ''
    years_active = (int(last_year) - int(first_year) + 1) if first_year and last_year else 1

    # Score: sent to them = strong signal
    score = (sent_total * 5) + (recv_total * 2) + (years_active * 3)
    if last_year and int(last_year) >= 2024:
        score += 20

    # Canon email: prefer personal, pick most-sent to
    best_email = canon_email
    if personal_emails:
        best_email = max(personal_emails, key=lambda e: email_sent_count.get(e, 0) + email_recv_count.get(e, 0))
    elif all_emails:
        best_email = max(all_emails, key=lambda e: email_sent_count.get(e, 0) + email_recv_count.get(e, 0))

    other_emails = sorted(e for e in all_emails if e != best_email)

    entity_stats[eid] = {
        'name': name.title(),
        'email': best_email,
        'all_emails': all_emails,
        'other_emails': other_emails,
        'sent_to_them': sent_total,
        'recv_from_them': recv_total,
        'first_year': first_year,
        'last_year': last_year,
        'years_active': years_active,
        'score': score,
        'rating': '',
        'notes': '',
    }

print(f"  Entity rows with interactions: {len(entity_stats)}")

# ── Also include unentitized contacts from sent history ────────────────────────
print("Adding un-entityied sent contacts...")
# Find emails in sent that aren't in any entity
entityized_emails = set(email_to_entity.keys())

solo_sent = con.execute(f"""
    SELECT lower(r.addr),
           COALESCE(r.name, ''),
           COUNT(*) as cnt,
           MIN(substr(m.sent_date,1,4)), MAX(substr(m.sent_date,1,4))
    FROM recipients r
    JOIN messages m ON m.id = r.message_id
    WHERE r.addr IS NOT NULL AND r.addr LIKE '%@%'
      AND r.kind IN ('to','cc')
      AND lower(m.sender_addr) IN ({_OWNER_ADDRS_SQL})
    GROUP BY lower(r.addr)
    HAVING cnt >= 1
""").fetchall()

FAKE_EID_BASE = 1000000
fake_eid = FAKE_EID_BASE
for email, name, cnt, yr_min, yr_max in solo_sent:
    if is_owner_addr(email) or is_bulk_email(email):
        continue
    if email in entityized_emails:
        continue  # already handled

    years_active = (int(yr_max) - int(yr_min) + 1) if yr_min and yr_max and yr_min.isdigit() and yr_max.isdigit() else 1
    recv = email_recv_count.get(email, 0)
    score = (cnt * 5) + (recv * 2) + (years_active * 3)
    if yr_max and yr_max.isdigit() and int(yr_max) >= 2024:
        score += 20

    display_name = name.strip().strip("'\"").title() if name.strip() else email.split('@')[0]

    entity_stats[fake_eid] = {
        'name': display_name,
        'email': email,
        'all_emails': [email],
        'other_emails': [],
        'sent_to_them': cnt,
        'recv_from_them': recv,
        'first_year': yr_min or '',
        'last_year': yr_max or '',
        'years_active': years_active,
        'score': score,
        'rating': '',
        'notes': '',
    }
    fake_eid += 1

print(f"  Total contacts after unentitized: {len(entity_stats)}")

# ── Load existing ratings ──────────────────────────────────────────────────────
print("Loading existing ratings...")
existing_ratings = {}  # canonical_email → {rating, notes, tier}
with open(CSV_IN, newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        email = (row.get('email') or '').strip().lower()
        rating = (row.get('rating') or '').strip()
        notes = (row.get('notes') or '').strip()
        tier = (row.get('tier') or '').strip()
        name = (row.get('name') or '').strip()
        if email:
            existing_ratings[email] = {'rating': rating, 'notes': notes, 'tier': tier, 'name': name}

print(f"  Loaded {len(existing_ratings)} existing ratings")

# Apply existing ratings to new rows
rated_count = 0
for eid, stats in entity_stats.items():
    # Check primary email
    email = stats['email'].lower()
    if email in existing_ratings:
        r = existing_ratings[email]
        stats['rating'] = r['rating']
        stats['notes'] = r['notes']
        rated_count += 1
        continue
    # Check other emails
    for e in stats['all_emails']:
        if e.lower() in existing_ratings:
            r = existing_ratings[e.lower()]
            stats['rating'] = r['rating']
            stats['notes'] = r['notes']
            rated_count += 1
            break

print(f"  Matched {rated_count} ratings")

# ── Sort and write CSV ────────────────────────────────────────────────────────
print("Writing CSV...")

rows_list = list(entity_stats.values())

# Sort: rated first (by score desc), unrated second (by score desc)
def sort_key(r):
    rating = r['rating']
    has_rating = 1 if rating != '' else 0
    # Rated: sort by rating desc then score desc
    # Unrated: sort by score desc
    try:
        rating_num = int(rating) if rating else -1
    except:
        rating_num = -1
    return (-has_rating, -rating_num, -r['score'])

rows_list.sort(key=sort_key)

# Filter: only include contacts where the owner sent at least 1 email OR they sent 3+ emails to the owner
rows_list = [r for r in rows_list
             if r['sent_to_them'] >= 1 or r['recv_from_them'] >= 3]

fieldnames = ['rating','name','email','other_emails','sent_to_them','recv_from_them',
              'first_year','last_year','years_active','score','notes']

with open(CSV_OUT, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
    writer.writeheader()
    for r in rows_list:
        r['other_emails'] = ' | '.join(r['other_emails'])
        writer.writerow(r)

# Stats
rated = [r for r in rows_list if r['rating'] != '']
unrated = [r for r in rows_list if r['rating'] == '']
print(f"\nCSV written: {len(rows_list)} total rows")
print(f"  Rated: {len(rated)}, Unrated: {len(unrated)}")
print(f"\nTop 20 by score:")
for r in rows_list[:20]:
    print(f"  [{r['rating']:2s}] {r['name']:35s} sent={r['sent_to_them']:4d} recv={r['recv_from_them']:4d} score={r['score']:5d}")

con.close()
