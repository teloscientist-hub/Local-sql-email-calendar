"""Generate RATED_CONTACTS_AUDIT.md from contacts_to_rate.csv.

Reads the CSV (csv module, handles quoted commas correctly), filters to rows
with a non-blank rating, groups by rating descending, and writes a markdown
doc with one table per rating bucket.

Adds a "Sent to (your addrs)" column by joining warehouse:
    sender_addr (in row's email list) → recipients.addr ∈ me_addresses
showing the top me-addresses they wrote to with message counts.

Usage:
    python -m tools.dump_rated_contacts
"""

from __future__ import annotations

import csv
import sqlite3
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "contacts_to_rate.csv"
OUT_PATH = ROOT / "RATED_CONTACTS_AUDIT.md"
WAREHOUSE_DB = ROOT / "warehouse.sqlite"
MAX_ME_ADDRS_SHOWN = 4  # show top-N owner addrs per contact


def _build_sender_to_me_map() -> dict[str, list[tuple[str, int]]]:
    """For every sender_addr (lowercased), return [(me_addr, count), ...]
    sorted by count desc. Aggregates over messages where that sender wrote
    to one of your known addresses (me_addresses table).
    """
    uri = f"file:{quote(str(WAREHOUSE_DB))}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("""
            SELECT LOWER(m.sender_addr) AS sender,
                   LOWER(r.addr)        AS me_addr,
                   COUNT(*)             AS n
            FROM messages m
            JOIN recipients r ON r.message_id = m.id
            WHERE LOWER(r.addr) IN (SELECT email FROM me_addresses)
              AND m.sender_addr IS NOT NULL
              AND m.sender_addr != ''
            GROUP BY LOWER(m.sender_addr), LOWER(r.addr)
        """).fetchall()
    finally:
        con.close()

    out: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for row in rows:
        out[row["sender"]].append((row["me_addr"], int(row["n"])))
    for s in out:
        out[s].sort(key=lambda x: x[1], reverse=True)
    return dict(out)


def _row_emails(row: dict) -> list[str]:
    """All emails on a CSV row (primary + other_emails split on '|'), lowercased."""
    out: list[str] = []
    primary = (row.get("email") or "").strip().lower()
    if primary:
        out.append(primary)
    other = (row.get("other_emails") or "").strip()
    if other:
        for piece in other.split("|"):
            p = piece.strip().lower()
            if p:
                out.append(p)
    return out


def _format_me_addrs(
    row: dict,
    sender_to_me: dict[str, list[tuple[str, int]]],
) -> str:
    agg: dict[str, int] = defaultdict(int)
    for em in _row_emails(row):
        for me_addr, n in sender_to_me.get(em, []):
            agg[me_addr] += n
    if not agg:
        return ""
    # Sorted by count desc (most-written-to first), but counts not shown.
    items = sorted(agg.items(), key=lambda kv: kv[1], reverse=True)
    return " · ".join(f"`{a}`" for a, _ in items)


def main() -> None:
    sender_to_me = _build_sender_to_me_map()
    print(f"loaded sender→owner map for {len(sender_to_me):,} senders")

    by_rating: dict[str, list[dict]] = defaultdict(list)
    total_rows = 0
    rated = 0
    with CSV_PATH.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total_rows += 1
            r = (row.get("rating") or "").strip()
            if r == "":
                continue
            rated += 1
            by_rating[r].append(row)

    lines: list[str] = []
    lines.append("# Rated Contacts Audit")
    lines.append("")
    lines.append(
        f"Generated from `email/contacts_to_rate.csv`. "
        f"Total CSV rows: {total_rows:,}.  Rows with a non-blank rating: {rated:,}."
    )
    lines.append("")
    lines.append("Within each bucket, rows are sorted by `score` (CSV's blended volume column) descending. "
                 "Use this to spot rows where the rating doesn't match how engaged the relationship actually was — "
                 "especially the rating=1 bucket, where 260 contacts may have been auto-defaulted rather than hand-rated.")
    lines.append("")

    # Summary table at the top
    lines.append("## Summary by rating")
    lines.append("")
    lines.append("| Rating | Count | Meaning |")
    lines.append("|---:|---:|---|")
    rating_meaning = {
        "9": "Top tier — VIPs, longtime friends, family core",
        "8": "Very important",
        "7": "Important",
        "6": "Above average",
        "5": "Mid (the fulcrum)",
        "4": "Mid-low",
        "3": "Low",
        "2": "Very low",
        "1": "Lowest non-zero",
        "0": "Explicitly zero (filtered out)",
    }
    for r in ["9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]:
        if r in by_rating:
            lines.append(f"| {r} | {len(by_rating[r])} | {rating_meaning.get(r, '')} |")
    lines.append("")

    # One table per rating bucket
    for r in sorted(by_rating.keys(), key=lambda x: (-int(x) if x.lstrip('-').isdigit() else 0)):
        rows = by_rating[r]
        # Sort by score desc
        def _score(row):
            try:
                return int(row.get("score", "0") or "0")
            except ValueError:
                return 0
        rows.sort(key=_score, reverse=True)

        lines.append(f"## Rating {r}  ({len(rows)} contacts)")
        lines.append("")
        lines.append("| Name | Primary email | Sent | Recv | Years | Score | Sent to (your addrs) | Notes / other emails |")
        lines.append("|---|---|---:|---:|:---:|---:|---|---|")
        for row in rows:
            name = (row.get("name") or "").strip().replace("|", "/")
            email = (row.get("email") or "").strip().replace("|", "/")
            sent = (row.get("sent_to_them") or "").strip()
            recv = (row.get("recv_from_them") or "").strip()
            first = (row.get("first_year") or "").strip()
            last = (row.get("last_year") or "").strip()
            score = (row.get("score") or "").strip()
            notes = (row.get("notes") or "").strip().replace("|", "/").replace("\n", " ")
            other = (row.get("other_emails") or "").strip().replace("|", "/").replace("\n", " ")
            years = f"{first}–{last}" if first and last and first != last else (first or last or "")
            extra = " · ".join(x for x in [other, notes] if x)
            me_addrs = _format_me_addrs(row, sender_to_me)
            lines.append(f"| {name} | `{email}` | {sent} | {recv} | {years} | {score} | {me_addrs} | {extra} |")
        lines.append("")

    OUT_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT_PATH}  ({rated:,} rated rows, {total_rows:,} total)")


if __name__ == "__main__":
    main()
