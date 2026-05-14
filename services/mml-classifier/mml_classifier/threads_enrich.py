"""Bulk enrichment of RFC-822 IDs for the sort-view overlay (Cmd+Option+V).

The plugin sends a list of RFC-822 IDs (one per thread, typically the
lastMessage.headerMessageId). We return a parallel list with per-message
sender info, effective rating + source, cluster, send-count engagement
for the sender, and which the owner address received it.

Plugin then sorts locally by whichever column the user clicks. We do NOT
sort here — the same enrichment list serves all sort orders, so we keep
the response small and let the client decide.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

from . import db, ratings


@dataclass(frozen=True)
class EnrichedThread:
    rfc_message_id: str
    matched: bool
    sender_name: str | None
    sender_addr: str | None
    subject: str | None
    received_date: str | None
    to_me_addr: str | None
    sender_send_count: int
    rating: int | None
    rating_source: str | None
    suggested_rating: int | None
    cluster_id: int | None
    cluster_name: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_SQL_TEMPLATE = """
SELECT
    m.message_id     AS rfc_msgid,
    m.id             AS warehouse_id,
    m.sender_name    AS sender_name,
    LOWER(COALESCE(m.sender_addr, '')) AS sender_addr,
    m.subject        AS subject,
    m.received_date  AS received_date,
    COALESCE(mc.cluster_id, sc.cluster_id) AS cluster_id,
    COALESCE(mc.cluster,    sc.cluster)    AS cluster_name,
    COALESCE(sc.priority_friend, 0)        AS priority_friend,
    COALESCE(
      (SELECT LOWER(r.addr)
       FROM recipients r
       WHERE r.message_id = m.id
         AND LOWER(r.addr) IN (SELECT email FROM me_addresses)
       ORDER BY r.id ASC
       LIMIT 1),
      (SELECT LOWER(r.addr)
       FROM recipients r
       WHERE r.message_id = m.id
       ORDER BY r.id ASC
       LIMIT 1)
    ) AS to_me_addr,
    COALESCE((
        SELECT e.send_count
        FROM contact_email_map cem
        JOIN engagement e ON e.contact_entity_id = cem.contact_entity_id
        WHERE cem.email = LOWER(COALESCE(m.sender_addr, ''))
    ), 0) AS sender_send_count,
    (SELECT mr.rating
     FROM message_ratings mr
     WHERE mr.message_id = m.id
     ORDER BY mr.rated_at DESC, mr.id DESC
     LIMIT 1) AS manual_message_rating,
    (SELECT rs.suggested_rating
     FROM rating_suggestions rs
     WHERE rs.message_id = m.id
     ORDER BY rs.scored_at DESC, rs.id DESC
     LIMIT 1) AS suggested_rating
FROM messages m
LEFT JOIN message_classifications mc ON mc.message_id = m.id
LEFT JOIN sender_classifications  sc ON LOWER(sc.sender_addr) = LOWER(m.sender_addr)
WHERE m.message_id IN ({placeholders})
"""


def enrich(rfc_message_ids: list[str]) -> list[EnrichedThread]:
    """Return one EnrichedThread per input id, preserving input order.

    Unknown ids return EnrichedThread(matched=False, ...) with null fields
    so the plugin can still render a row (or hide it).
    """
    cleaned = [mid.strip() for mid in rfc_message_ids if mid and mid.strip()]
    if not cleaned:
        return []

    placeholders = ",".join("?" * len(cleaned))
    sql = _SQL_TEMPLATE.format(placeholders=placeholders)

    with db.read_only() as con:
        rows = con.execute(sql, cleaned).fetchall()

    rows_by_rfc: dict[str, Any] = {r["rfc_msgid"]: r for r in rows}

    out: list[EnrichedThread] = []
    for rfc in cleaned:
        r = rows_by_rfc.get(rfc)
        if r is None:
            out.append(EnrichedThread(
                rfc_message_id=rfc, matched=False,
                sender_name=None, sender_addr=None,
                subject=None, received_date=None,
                to_me_addr=None, sender_send_count=0,
                rating=None, rating_source=None,
                suggested_rating=None,
                cluster_id=None, cluster_name=None,
            ))
            continue

        manual_mr = r["manual_message_rating"]
        decision = ratings.effective_rating_decision(
            sender_addr=r["sender_addr"],
            cluster_id=r["cluster_id"],
            priority_friend=bool(r["priority_friend"] or 0),
            manual_message_rating=(int(manual_mr) if manual_mr is not None else None),
        )

        suggested_raw = r["suggested_rating"]
        out.append(EnrichedThread(
            rfc_message_id=rfc, matched=True,
            sender_name=r["sender_name"],
            sender_addr=r["sender_addr"] or None,
            subject=r["subject"],
            received_date=r["received_date"],
            to_me_addr=r["to_me_addr"],
            sender_send_count=int(r["sender_send_count"] or 0),
            rating=decision.rating,
            rating_source=decision.source.value,
            suggested_rating=(int(suggested_raw) if suggested_raw is not None else None),
            cluster_id=r["cluster_id"],
            cluster_name=r["cluster_name"],
        ))
    return out
