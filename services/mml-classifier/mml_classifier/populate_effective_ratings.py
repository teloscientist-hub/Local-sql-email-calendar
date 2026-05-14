"""One-shot populator for warehouse.effective_ratings.

Computes the effective rating + source for every non-tombstoned message
(via ratings.effective_rating_decision) and persists to a shadow table.
The Mailspring sort plugin reads this table for Rating ↓ / Rating ↑ so
the visible badges and the sort order agree by construction.

Run:
    .venv/bin/python -m mml_classifier.populate_effective_ratings

Idempotent: drops + recreates the table on every run. ~320k messages
finishes in a few seconds because the inputs come from a single JOIN
(no per-message round-trip).

Phase 2.6 follow-up: have the sidecar incrementally maintain this on
each rating / classification write, so it stays fresh between batch runs.
"""

from __future__ import annotations

import logging
import time

from . import db, ratings

log = logging.getLogger(__name__)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS effective_ratings (
    message_id   INTEGER PRIMARY KEY REFERENCES messages(id),
    rating       INTEGER NOT NULL CHECK(rating >= 0 AND rating <= 9),
    source       TEXT NOT NULL,
    computed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_effective_ratings_rating ON effective_ratings(rating DESC);
"""

# One JOIN pulls every input effective_rating_decision needs. Avoids the
# 320k-round-trip cost of calling decision_for_message per message.
INPUTS_SQL = """
SELECT m.id,
       m.sender_addr,
       COALESCE(mc.cluster_id, sc.cluster_id)        AS cluster_id,
       COALESCE(sc.priority_friend, 0)               AS priority_friend,
       (SELECT mr.rating FROM message_ratings mr
        WHERE mr.message_id = m.id
        ORDER BY mr.rated_at DESC, mr.id DESC
        LIMIT 1)                                     AS manual_rating
FROM messages m
LEFT JOIN message_classifications mc ON mc.message_id = m.id
LEFT JOIN sender_classifications  sc ON LOWER(sc.sender_addr) = LOWER(m.sender_addr)
WHERE m.tombstone = 0
"""


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    t0 = time.monotonic()

    with db.read_write() as con:
        con.executescript(SCHEMA_SQL)
        # Wipe + repopulate. Cheap at this scale and keeps semantics simple.
        con.execute("DELETE FROM effective_ratings")

        rows = con.execute(INPUTS_SQL).fetchall()
        log.info("loaded %d message rows in %.2fs", len(rows), time.monotonic() - t0)

        # Force the CSV cache once before the loop.
        ratings.manual_ratings()

        batch: list[tuple[int, int, str]] = []
        BATCH = 5000
        n = 0
        for r in rows:
            decision = ratings.effective_rating_decision(
                sender_addr=r["sender_addr"],
                cluster_id=r["cluster_id"],
                priority_friend=bool(r["priority_friend"]),
                manual_message_rating=(int(r["manual_rating"])
                                       if r["manual_rating"] is not None else None),
            )
            batch.append((int(r["id"]), int(decision.rating), decision.source.value))
            if len(batch) >= BATCH:
                con.executemany(
                    "INSERT INTO effective_ratings (message_id, rating, source) VALUES (?,?,?)",
                    batch,
                )
                n += len(batch)
                batch.clear()

        if batch:
            con.executemany(
                "INSERT INTO effective_ratings (message_id, rating, source) VALUES (?,?,?)",
                batch,
            )
            n += len(batch)

        con.commit()

    log.info("wrote %d effective_ratings in %.2fs", n, time.monotonic() - t0)


if __name__ == "__main__":
    main()
