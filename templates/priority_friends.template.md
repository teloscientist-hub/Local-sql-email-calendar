# Priority friends

> The handful of people whose mail should always surface — auto-rated 8 regardless of cluster.

Copy this file to `priority_friends.md` (which is `.gitignore`'d), then fill in your own list. After editing, set `sender_classifications.priority_friend = 1` for each address listed here:

```sql
UPDATE sender_classifications
   SET priority_friend = 1
 WHERE LOWER(sender_addr) IN (
     'alex@example.com',
     'pat@othercompany.com',
     'sam@anotherbiz.com'
 );
```

If the sender doesn't have a row in `sender_classifications` yet, insert one:

```sql
INSERT OR IGNORE INTO sender_classifications
    (sender_addr, cluster_id, cluster, confidence, msg_count,
     classified_at, classified_by, priority_friend)
VALUES
    ('alex@example.com', 1, 'Longtime friends', 'high', 0,
     datetime('now'), 'manual', 1);
```

## The list

Keep this short — the value of the marker is that it's rare. Aim for under 30 people.

### Family (always escalate)
- `partner@example.com` — your partner / spouse
- `parent@example.com` — your parent
- `sibling@example.com` — your sibling

### Closest friends (don't miss)
- `alex@example.com` — closest friend
- `pat@example.com` — best friend from past decade
- `sam@example.com` — current weekly correspondent

### Business critical (current ventures)
- `cofounder@yourbiz.com` — your business partner
- `client@bigaccount.com` — most important active client

## How to keep this current

Once a quarter, scan your `contacts_to_rate.csv` for rows rated 8 or 9. Compare to this list. Add anyone whose mail you'd be unhappy to miss; remove anyone you've drifted from.

This list is more conservative than your 8/9 ratings — a person can rate 9 in the CSV without being a "never miss" priority. The priority flag is for relationships where missing one message would matter.
