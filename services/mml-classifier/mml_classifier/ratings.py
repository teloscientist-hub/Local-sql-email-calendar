"""Effective-rating computation per docs/RATING_SCALE.md.

Override priority (highest wins):
    0. Latest message_ratings.rating for this message (0–9 explicit; Phase 2.5 manual tag).
    1. Manual rating from contacts_to_rate.csv (1-9 — the owner hand-sets these).
    2. zero_value_senders membership → 0 (overrides everything except manual).
    3. priority_friend = 1 → floor of 8.
    4. cluster_id = 3 (Family) → 9.
    5. Other cluster default per CLUSTER_DEFAULT_RATING below.
    6. Default 0.

zero_value_senders is currently empty; treat absence-of-table as no-op.
The per-message tier (0) only applies via effective_rating_for_message() —
the pure effective_rating_for() function is unchanged for callers that
already have sender + cluster in hand.
"""

from __future__ import annotations

import csv
import logging
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from pathlib import Path

from . import config, db

log = logging.getLogger(__name__)


class RatingSource(str, Enum):
    """Where an effective rating came from. String-valued so the JSON
    serialization in /thread is the bare lowercase identifier (the plugin
    reads this directly as a discriminator)."""
    MANUAL          = "manual"           # latest message_ratings row (Ctrl+Opt+0..9 keystroke)
    CSV             = "csv"              # contacts_to_rate.csv hand-set
    PRIORITY_FRIEND = "priority_friend"  # sender_classifications.priority_friend=1 → 8
    FAMILY          = "family"           # cluster_id=3 → 9
    CLUSTER_DEFAULT = "cluster_default"  # auto-derived from CLUSTER_DEFAULT_RATING
    ZERO            = "zero"             # no signal at all


# Sources that represent a deliberate, person-level signal the owner put
# into the system. The plugin uses this set to gate whether to display the
# PersonBand pill: a "2" from the CSV means the owner chose it; a "2" from
# a cluster default doesn't.
PERSON_LEVEL_SOURCES: frozenset[RatingSource] = frozenset({
    RatingSource.MANUAL,
    RatingSource.CSV,
    RatingSource.PRIORITY_FRIEND,
    RatingSource.FAMILY,
})


@dataclass(frozen=True)
class RatingDecision:
    rating: int
    source: RatingSource

    def to_pair(self) -> tuple[int, str]:
        """Convenience tuple for callers that want the serializable string
        rather than the enum instance."""
        return (self.rating, self.source.value)


# ---- Cluster → default rating ---------------------------------------------
#
# Populate this dict after you've run the taxonomy generator
# (`python -m tools.taxonomy_generator`) and chosen your cluster IDs. Each
# entry maps a cluster_id (int) → default rating (int 0–9). See
# docs/RATING_SCALE.md for the meaning of each rating tier. Cluster 3 is
# special-cased to "Family" → 9 in effective_rating_decision() below — if
# you keep "Family" in your taxonomy, it should be cluster_id=3.
#
# Example shape (replace with your own clusters):
#
#     CLUSTER_DEFAULT_RATING: dict[int, int] = {
#         1: 7,    # Longtime friends (without priority_friend flag)
#         2: 5,    # Local groups / circles
#         3: 9,    # Family (no manual rating)
#         4: 6,    # Condolence / birthday / life event
#         ...
#         29: 1,   # Newsletters / lists
#         30: 0,   # Transactional / automated notifications
#         31: 1,   # Cold inbound pitches
#     }
CLUSTER_DEFAULT_RATING: dict[int, int] = {}

PRIORITY_FRIEND_FLOOR = 8
FAMILY_CLUSTER_RATING = 9
ZERO_VALUE_RATING = 0


# ---- contacts_to_rate.csv loader -------------------------------------------

@lru_cache(maxsize=1)
def manual_ratings() -> dict[str, int]:
    """Return {lowercase_email: rating} from contacts_to_rate.csv.

    Each row's `email` column is the primary key; `other_emails` is a
    pipe-separated list that maps to the same rating.
    """
    out: dict[str, int] = {}
    path: Path = config.CONTACTS_CSV
    if not path.exists():
        log.warning("contacts_to_rate.csv not found at %s", path)
        return out

    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            try:
                rating = int(row["rating"]) if row.get("rating") else 0
            except ValueError:
                continue
            if rating <= 0:
                continue
            primary = (row.get("email") or "").strip().lower()
            if primary:
                out[primary] = rating
            for alt in (row.get("other_emails") or "").split("|"):
                alt = alt.strip().lower()
                if alt:
                    # If multiple rows mention the same alt, the higher rating wins.
                    if out.get(alt, 0) < rating:
                        out[alt] = rating
    return out


def reload_ratings() -> None:
    """Drop the cache so the next call re-reads the CSV (e.g. on SIGHUP)."""
    manual_ratings.cache_clear()


# ---- Effective rating ------------------------------------------------------

def effective_rating_decision(
    *,
    sender_addr: str | None,
    cluster_id: int | None,
    priority_friend: bool = False,
    manual_message_rating: int | None = None,
) -> RatingDecision:
    """Compute effective rating + source from all available signals.

    The manual_message_rating kwarg is the per-message tier-0 override
    (latest message_ratings.rating). If supplied non-None, it wins outright.
    Caller is responsible for joining warehouse data first.
    """
    if manual_message_rating is not None:
        return RatingDecision(int(manual_message_rating), RatingSource.MANUAL)

    sender = (sender_addr or "").strip().lower()
    if sender:
        csv_rating = manual_ratings().get(sender)
        if csv_rating is not None:
            return RatingDecision(int(csv_rating), RatingSource.CSV)

    if cluster_id == 3:
        return RatingDecision(FAMILY_CLUSTER_RATING, RatingSource.FAMILY)
    if priority_friend:
        return RatingDecision(PRIORITY_FRIEND_FLOOR, RatingSource.PRIORITY_FRIEND)
    if cluster_id is not None and cluster_id in CLUSTER_DEFAULT_RATING:
        return RatingDecision(CLUSTER_DEFAULT_RATING[cluster_id], RatingSource.CLUSTER_DEFAULT)
    return RatingDecision(0, RatingSource.ZERO)


def effective_rating_for(
    *,
    sender_addr: str | None,
    cluster_id: int | None,
    priority_friend: bool = False,
) -> int:
    """Back-compat wrapper — returns just the int rating. Existing callers
    that don't care about source keep working unchanged."""
    return effective_rating_decision(
        sender_addr=sender_addr,
        cluster_id=cluster_id,
        priority_friend=priority_friend,
    ).rating


def decision_for_message(message_id: int) -> RatingDecision:
    """Look up sender_addr + cluster_id + priority_friend + latest manual
    tag for a warehouse message_id, then compute the effective rating
    decision (rating + source)."""
    with db.read_only() as con:
        row = con.execute(
            """
            SELECT m.sender_addr,
                   COALESCE(mc.cluster_id, sc.cluster_id) AS cluster_id,
                   COALESCE(sc.priority_friend, 0)        AS priority_friend,
                   (SELECT rating FROM message_ratings
                    WHERE message_id = m.id
                    ORDER BY rated_at DESC, id DESC
                    LIMIT 1)                              AS manual_message_rating
            FROM messages m
            LEFT JOIN message_classifications mc ON mc.message_id = m.id
            LEFT JOIN sender_classifications  sc ON LOWER(sc.sender_addr) = LOWER(m.sender_addr)
            WHERE m.id = ?
            """,
            (message_id,),
        ).fetchone()
    if row is None:
        return RatingDecision(0, RatingSource.ZERO)
    return effective_rating_decision(
        sender_addr=row["sender_addr"],
        cluster_id=row["cluster_id"],
        priority_friend=bool(row["priority_friend"]),
        manual_message_rating=(int(row["manual_message_rating"])
                                if row["manual_message_rating"] is not None
                                else None),
    )


def effective_rating_for_message(message_id: int) -> int:
    """Back-compat wrapper — returns just the int rating."""
    return decision_for_message(message_id).rating
