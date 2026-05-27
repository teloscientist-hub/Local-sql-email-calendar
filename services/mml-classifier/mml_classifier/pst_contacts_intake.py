#!/usr/bin/env python3
"""Import rich contact metadata from an Outlook PST contacts archive into
warehouse.sqlite.

This is for *contacts-only* PSTs (IPM.Contact items), NOT mail PSTs — use
pipeline/01_ingest_pypff_walk.py for message PSTs.

It is purely additive: it never tombstones or overwrites rows from other
sources (Google Contacts, Mailspring). Phones / addresses / group memberships
reuse the existing contact_phones / contact_addresses / contact_groups tables;
organization / title / web page / file-as land in pst_contact_meta
(migration 13_pst_contacts.sql).

Dry-run by default. Pass --commit to write.

Run with SYSTEM python3 (it has pypff; the mml-classifier venv does not):

    python3 services/mml-classifier/mml_classifier/pst_contacts_intake.py \
        --pst "contacts.pst" --db warehouse.sqlite

    # then, after reviewing the report:
    python3 .../pst_contacts_intake.py --pst ... --db ... --commit
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import hashlib
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict

try:
    import pypff
except ImportError:
    sys.exit("ERROR: pypff not installed for this interpreter. Run with system "
             "python3 (pip3 install libpff-python), not the mml-classifier venv.")

INGESTER_VERSION = "pst-contacts-intake@0.1.0"

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

# Standard MAPI property tags (NOT named props — these are stable across PSTs).
PR_SUBJECT = 0x0037          # contact "file as" -> "Last, First"
PR_DISPLAY_NAME = 0x3001
PR_GIVEN_NAME = 0x3A06
PR_SURNAME = 0x3A11
PR_COMPANY_NAME = 0x3A16
PR_TITLE = 0x3A17
PR_BUSINESS_HOME_PAGE = 0x3A51
PR_PERSONAL_HOME_PAGE = 0x3A50
PR_SMTP_ADDRESS = 0x39FE

PHONE_TAGS = {
    0x3A08: "business", 0x3A09: "home", 0x3A0A: "business",
    0x3A1A: "primary", 0x3A1B: "business", 0x3A1C: "mobile",
    0x3A1D: "radio", 0x3A1E: "car", 0x3A1F: "other",
    0x3A21: "pager", 0x3A2E: "assistant", 0x3A2F: "home",
    0x3A57: "company", 0x3A23: "fax", 0x3A24: "fax", 0x3A25: "fax",
}

# Each address block: label -> {component: proptag}
ADDRESS_BLOCKS = {
    "home": {"street": 0x3A5D, "city": 0x3A59, "region": 0x3A5C,
             "postal_code": 0x3A5B, "country": 0x3A5A},
    "work": {"street": 0x3A29, "city": 0x3A27, "region": 0x3A28,
             "postal_code": 0x3A2A, "country": 0x3A26},
    "other": {"street": 0x3A63, "city": 0x3A5F, "region": 0x3A62,
              "postal_code": 0x3A61, "country": 0x3A60},
}

GROUP_FOLDERS = {"bus contacts", "luminaries assistant",
                 "luminaries direct", "luminaries personal"}


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _me_addresses(con: sqlite3.Connection) -> set[str]:
    rows = con.execute("SELECT email FROM me_addresses").fetchall()
    return {r[0] for r in rows if r[0]}


def _me_domains(con: sqlite3.Connection) -> set[str]:
    return {a.split("@", 1)[1] for a in _me_addresses(con) if "@" in a}


def is_me(addr: str, me_addrs: set[str], me_domains: set[str]) -> bool:
    a = (addr or "").lower().strip()
    if not a:
        return True
    if a in me_addrs:
        return True
    domain = a.split("@")[-1] if "@" in a else ""
    return domain in me_domains


def _clean(s):
    if not isinstance(s, str):
        return ""
    # strip leading control bytes (PR_SUBJECT carries \x01\x01 prefixes)
    return "".join(ch for ch in s if ch == "\n" or ch == "\t"
                   or ord(ch) >= 0x20).strip()


def _digits(raw: str) -> str:
    return re.sub(r"\D", "", raw or "")


def _find_folder(folder, target):
    for i in range(folder.number_of_sub_folders):
        sf = folder.get_sub_folder(i)
        if (sf.name or "").lower() == target.lower():
            return sf
        r = _find_folder(sf, target)
        if r:
            return r
    return None


# ── Extraction ────────────────────────────────────────────────────────────────

class PstContact:
    __slots__ = ("display", "given", "surname", "file_as", "emails", "phones",
                 "addresses", "organization", "title", "web_page",
                 "group_name", "source_folder")

    @property
    def item_key(self) -> str:
        """Deterministic fingerprint of this PST card (idempotency key).
        Folder/group deliberately excluded so the same person appearing in
        several folders maps to one stable key."""
        parts = [
            (self.file_as or "").lower().strip(),
            (self.display or "").lower().strip(),
            (self.given or "").lower().strip(),
            (self.surname or "").lower().strip(),
            "|".join(sorted(self.emails)),
            "|".join(sorted(n for _, _, n in self.phones)),
        ]
        return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()

    def __init__(self):
        self.display = ""
        self.given = ""
        self.surname = ""
        self.file_as = ""
        self.emails = []          # list[str] lowercased, deduped, non-me
        self.phones = []          # list[(label, display, normalized)]
        self.addresses = []       # list[dict(label,street,city,region,postal_code,country,formatted)]
        self.organization = ""
        self.title = ""
        self.web_page = ""
        self.group_name = None    # contact_groups label, or None
        self.source_folder = ""

    @property
    def best_name(self) -> str:
        if self.display:
            return self.display
        n = " ".join(p for p in (self.given, self.surname) if p).strip()
        if n:
            return n
        if self.emails:
            return self.emails[0]
        return "(unknown)"

    @property
    def has_data(self) -> bool:
        return bool(self.phones or self.addresses)


def _parse_contact(msg, group_name, source_folder,
                   me_addrs: set[str], me_domains: set[str]) -> PstContact:
    c = PstContact()
    c.group_name = group_name
    c.source_folder = source_folder
    by_tag = {}
    try:
        rs = msg.get_record_set(0)
    except Exception:
        return c
    emails = []
    for e in range(rs.number_of_entries):
        try:
            en = rs.get_entry(e)
            et = en.entry_type
        except Exception:
            continue
        try:
            val = en.data_as_string
        except Exception:
            val = None
        if not val:
            continue
        val = _clean(val)
        if not val:
            continue
        by_tag[et] = val
        # Email lives in named props (>=0x8000) or PR_SMTP_ADDRESS.
        if et >= 0x8000 or et == PR_SMTP_ADDRESS:
            for m in EMAIL_RE.findall(val):
                ml = m.lower()
                if "microsoft.com" in ml or ml.endswith(".outlook"):
                    continue
                if is_me(ml, me_addrs, me_domains):
                    continue
                emails.append(ml)

    c.display = by_tag.get(PR_DISPLAY_NAME, "")
    c.given = by_tag.get(PR_GIVEN_NAME, "")
    c.surname = by_tag.get(PR_SURNAME, "")
    c.file_as = by_tag.get(PR_SUBJECT, "")
    c.organization = by_tag.get(PR_COMPANY_NAME, "")
    c.title = by_tag.get(PR_TITLE, "")
    c.web_page = (by_tag.get(PR_BUSINESS_HOME_PAGE)
                  or by_tag.get(PR_PERSONAL_HOME_PAGE) or "")

    seen_e = set()
    for ml in emails:
        if ml not in seen_e:
            seen_e.add(ml)
            c.emails.append(ml)

    for tag, label in PHONE_TAGS.items():
        raw = by_tag.get(tag)
        if not raw:
            continue
        norm = _digits(raw)
        if len(norm) < 7:
            continue
        c.phones.append((label, raw, norm))

    for label, comp in ADDRESS_BLOCKS.items():
        parts = {k: by_tag.get(tag, "") for k, tag in comp.items()}
        if not any(parts.values()):
            continue
        line2 = " ".join(p for p in (parts["city"], parts["region"],
                                      parts["postal_code"]) if p).strip()
        formatted = ", ".join(p for p in (parts["street"], line2,
                                           parts["country"]) if p)
        c.addresses.append({"label": label, **parts, "formatted": formatted})

    return c


def _walk(folder, group_name, path, out, me_addrs, me_domains):
    fname = folder.name or "(root)"
    here = f"{path}/{fname}" if path else fname
    n = folder.number_of_sub_messages
    for i in range(n):
        try:
            msg = folder.get_sub_message(i)
        except Exception:
            continue
        out.append(_parse_contact(msg, group_name, here, me_addrs, me_domains))
    for i in range(folder.number_of_sub_folders):
        sf = folder.get_sub_folder(i)
        sub_name = (sf.name or "").lower()
        sub_group = sub_name if sub_name in GROUP_FOLDERS else group_name
        _walk(sf, sub_group, here, out, me_addrs, me_domains)


def extract(pst_path, me_addrs: set[str], me_domains: set[str]) -> list[PstContact]:
    pff = pypff.file()
    pff.open(pst_path)
    root = pff.get_root_folder()
    contacts_folder = _find_folder(root, "Contacts")
    if contacts_folder is None:
        pff.close()
        raise SystemExit("No 'Contacts' folder found in PST.")
    out: list[PstContact] = []
    _walk(contacts_folder, None, "", out, me_addrs, me_domains)
    pff.close()
    return out


# ── Entity resolution + write ─────────────────────────────────────────────────

def _entities_for_emails(con, emails):
    if not emails:
        return []
    ph = ",".join("?" * len(emails))
    rows = con.execute(
        f"SELECT DISTINCT contact_entity_id FROM contact_email_map "
        f"WHERE email IN ({ph}) AND tombstone = 0", emails).fetchall()
    return [r[0] for r in rows]


def _pick_winner(con, ids):
    counts = {}
    for eid in ids:
        counts[eid] = con.execute(
            "SELECT COUNT(*) FROM contact_email_map "
            "WHERE contact_entity_id = ? AND tombstone = 0", (eid,)).fetchone()[0]
    winner = min(ids, key=lambda e: (-counts[e], e))
    return winner, [e for e in ids if e != winner]


def _create_entity(con, c: PstContact):
    now = _now()
    cur = con.execute(
        "INSERT INTO contact_entities "
        "(canonical_name, canonical_email, is_mark, is_list_addr, "
        " created_at, updated_at, ingester_version, tombstone) "
        "VALUES (?, ?, 0, 0, ?, ?, ?, 0)",
        (c.best_name, c.emails[0] if c.emails else None, now, now,
         INGESTER_VERSION))
    return cur.lastrowid


def _write_enrichment(con, eid, c: PstContact, source_pst, stats):
    now = _now()
    for idx, em in enumerate(c.emails):
        con.execute(
            "INSERT INTO contact_email_map "
            "(email, contact_entity_id, primary_for_contact, "
            " first_seen_at, last_seen_at, tombstone) "
            "VALUES (?, ?, ?, ?, ?, 0) "
            "ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at",
            (em, eid, 1 if idx == 0 else 0, now, now))
    for label, disp, norm in c.phones:
        cur = con.execute(
            "INSERT INTO contact_phones "
            "(contact_entity_id, phone_normalized, phone_display, label, "
            " primary_flag, tombstone) VALUES (?, ?, ?, ?, 0, 0) "
            "ON CONFLICT(contact_entity_id, phone_normalized) DO NOTHING",
            (eid, norm, disp, label))
        if cur.rowcount:
            stats["phones"] += 1
    for a in c.addresses:
        dup = con.execute(
            "SELECT 1 FROM contact_addresses WHERE contact_entity_id = ? "
            "AND IFNULL(street,'') = ? AND IFNULL(city,'') = ? "
            "AND IFNULL(postal_code,'') = ? AND tombstone = 0",
            (eid, a["street"], a["city"], a["postal_code"])).fetchone()
        if dup:
            continue
        con.execute(
            "INSERT INTO contact_addresses "
            "(contact_entity_id, label, street, city, region, postal_code, "
            " country, formatted, tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
            (eid, a["label"], a["street"], a["city"], a["region"],
             a["postal_code"], a["country"], a["formatted"]))
        stats["addresses"] += 1
    if c.group_name:
        cur = con.execute(
            "INSERT INTO contact_groups "
            "(contact_entity_id, group_name, google_group_resource, tombstone) "
            "VALUES (?, ?, NULL, 0) "
            "ON CONFLICT(contact_entity_id, group_name) DO NOTHING",
            (eid, c.group_name))
        if cur.rowcount:
            stats["groups"] += 1
    con.execute(
        "INSERT INTO pst_contact_meta "
        "(contact_entity_id, source_pst, pst_item_key, file_as, organization, "
        " title, web_page, source_folder, imported_at, ingester_version, "
        " tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) "
        "ON CONFLICT(source_pst, pst_item_key) DO UPDATE SET "
        "  contact_entity_id = excluded.contact_entity_id, "
        "  file_as = excluded.file_as, organization = excluded.organization, "
        "  title = excluded.title, web_page = excluded.web_page, "
        "  source_folder = excluded.source_folder, "
        "  imported_at = excluded.imported_at, "
        "  ingester_version = excluded.ingester_version, tombstone = 0",
        (eid, source_pst, c.item_key, c.file_as or None,
         c.organization or None, c.title or None, c.web_page or None,
         c.source_folder, now, INGESTER_VERSION))


def _resolve(con, c: PstContact, source_pst, stats, conflicts, name_index):
    """Return entity id (creating one if needed), or None to skip.

    Idempotency: if this exact PST card was already imported (matched by
    source_pst + item_key in pst_contact_meta), reuse that entity. This is
    what makes the name-only path safe to re-run."""
    prior = con.execute(
        "SELECT contact_entity_id FROM pst_contact_meta "
        "WHERE source_pst = ? AND pst_item_key = ? AND tombstone = 0",
        (source_pst, c.item_key)).fetchone()
    if prior:
        stats["reclaimed"] += 1
        return prior[0]
    if c.emails:
        ids = _entities_for_emails(con, c.emails)
        if len(ids) == 0:
            stats["new_entity"] += 1
            return _create_entity(con, c)
        if len(ids) == 1:
            stats["claimed_1"] += 1
            return ids[0]
        winner, losers = _pick_winner(con, ids)
        stats["multi_entity_conflict"] += 1
        conflicts.append({"name": c.best_name,
                          "emails": ";".join(c.emails),
                          "winner_entity": winner,
                          "other_entities": ";".join(map(str, losers)),
                          "kind": "email-multi-entity"})
        return winner
    # name-only
    if not c.has_data:
        stats["skipped_empty"] += 1
        return None
    key = c.best_name.lower().strip()
    matched = name_index.get(key, [])
    if len(matched) == 1:
        stats["name_claimed"] += 1
        return matched[0]
    if len(matched) > 1:
        conflicts.append({"name": c.best_name, "emails": "",
                          "winner_entity": "", "other_entities": ";".join(map(str, matched)),
                          "kind": "name-ambiguous-created-new"})
    stats["name_new_entity"] += 1
    return _create_entity(con, c)


def _load_name_index(con):
    idx = defaultdict(list)
    for eid, nm in con.execute(
            "SELECT id, canonical_name FROM contact_entities "
            "WHERE tombstone = 0 AND canonical_name IS NOT NULL"):
        idx[nm.lower().strip()].append(eid)
    return idx


def _print_report(contacts, stats, conflicts, sample, new_emails):
    print("\n=== CALIBRATION SAMPLE (verify fields are not swapped) ===")
    for c in sample:
        print(f"  {c.best_name!r}")
        print(f"    given={c.given!r} surname={c.surname!r} org={c.organization!r} title={c.title!r}")
        print(f"    emails={c.emails}")
        print(f"    phones={[(l, d) for l, d, _ in c.phones]}")
        for a in c.addresses:
            print(f"    addr[{a['label']}]={a['formatted']!r}")
        print(f"    group={c.group_name!r}  folder={c.source_folder!r}")
    print("\n=== TOTALS ===")
    print(f"  contacts scanned          : {len(contacts)}")
    print(f"  with >=1 email            : {sum(1 for c in contacts if c.emails)}")
    print(f"  name-only with phone/addr : {sum(1 for c in contacts if not c.emails and c.has_data)}")
    print("\n=== RESOLUTION ===")
    for k in ("reclaimed", "new_entity", "claimed_1", "multi_entity_conflict",
              "name_claimed", "name_new_entity", "skipped_empty"):
        print(f"  {k:24s}: {stats[k]}")
    print("\n=== PLANNED WRITES ===")
    for k in ("phones", "addresses", "groups"):
        print(f"  {k:24s}: {stats[k]}")
    print(f"  new emails (not in map)  : {len(new_emails)}")
    print(f"  multi-entity conflicts   : {len(conflicts)}")
    if conflicts:
        print("  first 10 conflicts:")
        for r in conflicts[:10]:
            print(f"    [{r['kind']}] {r['name']} {r['emails']} "
                  f"-> winner={r['winner_entity']} others={r['other_entities']}")


def main():
    ap = argparse.ArgumentParser(description="Import PST contacts metadata → warehouse.")
    ap.add_argument("--pst", required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--commit", action="store_true",
                    help="Write changes. Default is dry-run.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Process only first N contacts (debug).")
    ap.add_argument("--conflicts-csv", default=None,
                    help="Where to write the multi-entity conflict report "
                         "(default: alongside the PST).")
    args = ap.parse_args()

    source_pst = os.path.basename(args.pst)

    con = sqlite3.connect(args.db)
    con.execute("PRAGMA foreign_keys = ON")

    # Load owner identity from me_addresses table (no hardcoded addresses).
    me_addrs = _me_addresses(con)
    me_domains = _me_domains(con)

    # pre-flight: ensure migration applied
    has_meta = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' "
        "AND name='pst_contact_meta'").fetchone()
    if not has_meta and args.commit:
        con.close()
        sys.exit("ERROR: pst_contact_meta missing. Apply migration "
                 "13_pst_contacts.sql before --commit.")

    contacts = extract(args.pst, me_addrs, me_domains)
    if args.limit:
        contacts = contacts[:args.limit]

    known_emails = set(r[0] for r in
                       con.execute("SELECT email FROM contact_email_map"))
    all_pst_emails = set(e for c in contacts for e in c.emails)
    new_emails = all_pst_emails - known_emails

    name_index = _load_name_index(con)
    stats = Counter()
    conflicts = []

    sample = [c for c in contacts
              if c.phones and c.addresses][:5]

    if not args.commit:
        # dry-run: resolve against a read-only snapshot (no writes committed)
        for c in contacts:
            try:
                _resolve(con, c, source_pst, stats, conflicts, name_index)
            except Exception as ex:
                stats["resolve_errors"] += 1
                print(f"  resolve error: {c.best_name}: {ex}", file=sys.stderr)
            # count planned enrichment without writing
            stats["phones"] += len(c.phones)
            stats["addresses"] += len(c.addresses)
            if c.group_name:
                stats["groups"] += 1
        con.rollback()
        con.close()
        _print_report(contacts, stats, conflicts, sample, new_emails)
        print("\nDRY RUN — no changes written. Re-run with --commit to apply.")
        return

    written = 0
    for c in contacts:
        try:
            eid = _resolve(con, c, source_pst, stats, conflicts, name_index)
            if eid is None:
                continue
            _write_enrichment(con, eid, c, source_pst, stats)
            written += 1
        except Exception as ex:
            stats["resolve_errors"] += 1
            print(f"  write error: {c.best_name}: {ex}", file=sys.stderr)
    con.commit()

    csv_path = args.conflicts_csv or os.path.join(
        os.path.dirname(os.path.abspath(args.pst)),
        f"{source_pst}.conflicts.csv")
    if conflicts:
        with open(csv_path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["kind", "name", "emails",
                                              "winner_entity", "other_entities"])
            w.writeheader()
            w.writerows(conflicts)

    con.close()
    _print_report(contacts, stats, conflicts, sample, new_emails)
    print(f"\nCOMMITTED. entities enriched: {written}")
    if conflicts:
        print(f"Conflict report: {csv_path} ({len(conflicts)} rows) — review separately.")


if __name__ == "__main__":
    main()
