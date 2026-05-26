"""Enrich contacts_to_rate.csv with system-derived columns.

For each row in contacts_to_rate.csv, joins against `sender_classifications`
in the warehouse to add columns describing what the system thinks about that
sender — priority_friend flag, cluster, what the auto-computed rating would
be — so the user can sort the spreadsheet by those signals and decide which
auto-classified rows deserve a manual rating override in the `rating` column.

The script is RE-RUNNABLE and PRESERVES user edits:
  - User-editable columns (rating, name, notes, email, other_emails, etc.)
    are read and written verbatim.
  - System-derived columns (sys_*) are recomputed on every run.
  - The CSV is backed up to _historical/source-data-exports/ before write.

Match strategy per row:
  1. Try the lowercase primary `email`.
  2. If no match, try each pipe-separated address in `other_emails`.
  3. `sys_matched_via` records which address actually matched, or '' if none.

Run:
    cd services/mml-classifier
    .venv/bin/python -m mml_classifier.enrich_contacts_csv

Note: ratings.manual_ratings() is LRU-cached. We feed the *new* CSV's rating
values directly into effective_rating_decision() rather than going through
that cache so the computed sys_effective_source/sys_effective_rating reflect
the file we're about to write.
"""
from __future__ import annotations

import csv
import logging
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from . import config, db
from .ratings import (
    CLUSTER_DEFAULT_RATING,
    FAMILY_CLUSTER_RATING,
    PRIORITY_FRIEND_FLOOR,
    RatingDecision,
    RatingSource,
)

log = logging.getLogger(__name__)

# Columns we add. Order is the order they appear in the output CSV (appended
# after the existing columns).
SYS_COLUMNS = [
    "sys_priority_friend",
    "sys_cluster_id",
    "sys_cluster",
    "sys_cluster_default_rating",
    "sys_effective_source",
    "sys_effective_rating",
    "sys_matched_via",
]


def _load_sender_classifications() -> dict[str, dict[str, Any]]:
    """{lowercase_email -> {priority_friend, cluster_id, cluster}}."""
    out: dict[str, dict[str, Any]] = {}
    with db.read_only() as con:
        rows = con.execute(
            "SELECT LOWER(sender_addr) AS sender_addr, "
            "       cluster_id, cluster, "
            "       COALESCE(priority_friend, 0) AS priority_friend "
            "FROM sender_classifications"
        ).fetchall()
    for r in rows:
        addr = (r["sender_addr"] or "").strip().lower()
        if not addr:
            continue
        out[addr] = {
            "priority_friend": int(r["priority_friend"] or 0),
            "cluster_id": r["cluster_id"],
            "cluster": r["cluster"],
        }
    return out


def _emails_for_row(row: dict[str, str]) -> list[str]:
    """Primary email first, then each entry in other_emails (pipe-separated)."""
    out: list[str] = []
    primary = (row.get("email") or "").strip().lower()
    if primary:
        out.append(primary)
    for alt in (row.get("other_emails") or "").split("|"):
        alt = alt.strip().lower()
        if alt and alt not in out:
            out.append(alt)
    return out


def _decision_inline(
    *,
    csv_rating: int,
    cluster_id: int | None,
    priority_friend: bool,
) -> RatingDecision:
    """Same logic as ratings.effective_rating_decision but takes the user's
    CSV rating directly instead of consulting the LRU-cached lookup. This
    way the computed source reflects the rating we're about to write to disk,
    not whatever's still in the in-memory cache."""
    if csv_rating > 0:
        return RatingDecision(int(csv_rating), RatingSource.CSV)
    if cluster_id == 3:
        return RatingDecision(FAMILY_CLUSTER_RATING, RatingSource.FAMILY)
    if priority_friend:
        return RatingDecision(PRIORITY_FRIEND_FLOOR, RatingSource.PRIORITY_FRIEND)
    if cluster_id is not None and cluster_id in CLUSTER_DEFAULT_RATING:
        return RatingDecision(CLUSTER_DEFAULT_RATING[cluster_id], RatingSource.CLUSTER_DEFAULT)
    return RatingDecision(0, RatingSource.ZERO)


def _backup_path(csv_path: Path) -> Path:
    backup_dir = csv_path.parent / "_historical" / "source-data-exports"
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    return backup_dir / f"contacts_to_rate.before-sys-enrich-{ts}.csv"


def enrich(csv_path: Path | None = None, *, dry_run: bool = False) -> dict[str, int]:
    """Read CSV, enrich with sys_* columns, write back. Returns stat counts."""
    path = csv_path or config.CONTACTS_CSV
    if not path.exists():
        raise FileNotFoundError(f"contacts_to_rate.csv not found at {path}")

    sndcls = _load_sender_classifications()
    log.info("loaded %d sender_classifications rows", len(sndcls))

    # Read all rows + original fieldnames.
    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        original_fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    # Preserve existing columns; drop+re-add sys_* so they end up at the right
    # spot if the user has reordered them, and so stale values are refreshed.
    user_fieldnames = [c for c in original_fieldnames if c not in SYS_COLUMNS]
    out_fieldnames = user_fieldnames + SYS_COLUMNS

    stats = {
        "rows": len(rows),
        "matched": 0,
        "priority_friend": 0,
        "family": 0,
        "cluster_default": 0,
        "user_csv_rating": 0,
        "zero": 0,
    }

    for row in rows:
        # Match.
        match_email = ""
        sc: dict[str, Any] | None = None
        for em in _emails_for_row(row):
            if em in sndcls:
                sc = sndcls[em]
                match_email = em
                break

        priority_friend = bool(sc and sc["priority_friend"])
        cluster_id: int | None = sc["cluster_id"] if sc else None
        cluster_name: str = (sc["cluster"] or "") if sc else ""

        if sc is not None:
            stats["matched"] += 1
        if priority_friend:
            stats["priority_friend"] += 1
        if cluster_id == 3:
            stats["family"] += 1

        # Read user's current rating value (preserve).
        try:
            csv_rating_val = int((row.get("rating") or "0").strip() or 0)
        except ValueError:
            csv_rating_val = 0

        decision = _decision_inline(
            csv_rating=csv_rating_val,
            cluster_id=cluster_id,
            priority_friend=priority_friend,
        )

        if decision.source == RatingSource.CSV:
            stats["user_csv_rating"] += 1
        elif decision.source == RatingSource.CLUSTER_DEFAULT:
            stats["cluster_default"] += 1
        elif decision.source == RatingSource.ZERO:
            stats["zero"] += 1

        cluster_default = (
            CLUSTER_DEFAULT_RATING.get(cluster_id, "") if cluster_id is not None else ""
        )

        row["sys_priority_friend"] = "1" if priority_friend else "0"
        row["sys_cluster_id"] = "" if cluster_id is None else str(cluster_id)
        row["sys_cluster"] = cluster_name
        row["sys_cluster_default_rating"] = "" if cluster_default == "" else str(cluster_default)
        row["sys_effective_source"] = decision.source.value
        row["sys_effective_rating"] = str(decision.rating)
        row["sys_matched_via"] = match_email

    if dry_run:
        log.info("dry_run: would write %d rows; not touching %s", len(rows), path)
        return stats

    # Backup + write.
    backup = _backup_path(path)
    shutil.copy2(path, backup)
    log.info("backed up to %s", backup)

    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=out_fieldnames)
        writer.writeheader()
        for row in rows:
            # Only emit known fields (drop any stray keys).
            writer.writerow({k: row.get(k, "") for k in out_fieldnames})
    tmp.replace(path)
    log.info("wrote %s (%d rows, %d cols)", path, len(rows), len(out_fieldnames))
    return stats


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    dry = "--dry-run" in sys.argv
    s = enrich(dry_run=dry)
    print(
        f"rows={s['rows']}  matched={s['matched']}  "
        f"priority_friend={s['priority_friend']}  family={s['family']}  "
        f"cluster_default={s['cluster_default']}  csv_rating={s['user_csv_rating']}  "
        f"zero={s['zero']}"
        + ("  (dry-run, no write)" if dry else "")
    )
