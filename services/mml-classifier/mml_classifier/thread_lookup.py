"""Plugin-facing thread state aggregation.

Plugin sends RFC-822 Message-IDs (Mailspring's `Message.headerMessageId`).
We resolve them to warehouse `messages.id` rows, join classification + content
scoring + manual rating, and aggregate to a single ThreadState the plugin
renders. Choices when aggregating across messages in a thread:

    rating               — max across thread (best contact wins)
    cluster_id/name      — most-recently-classified message's cluster
    importance_score     — max across thread (newest tied score wins)
    tldr_text            — paired with the message that owns the max importance_score
    scored_at            — paired likewise
    suggested_rating     — latest by scored_at across thread (mirrors cluster)
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

from . import config, db, ratings


@dataclass(frozen=True)
class ThreadState:
    rating: int | None
    cluster_id: int | None
    cluster_name: str | None
    importance_score: float | None
    tldr_text: str | None
    reason: str | None
    scored_at: str | None
    matched_message_count: int
    # The the owner-address most recently written-to in this thread (one of
    # me_addresses.email). Lets the plugin show "which inbox" each row
    # came in on. None if no recipient matches a mark-address.
    to_me_addr: str | None = None
    # Where the thread-level `rating` came from. Plugin uses this to gate
    # whether to display the PersonBand pill — only sources that represent a
    # deliberate person-level signal (manual, csv, priority_friend, family)
    # should surface, not cluster_default fallbacks.
    # Values: "manual" | "csv" | "priority_friend" | "family" | "cluster_default" | "zero" | None
    rating_source: str | None = None
    # Phase 6.0.f — LLM-suggested rating for the thread (latest by scored_at
    # across the thread's messages, filtered to the current rating
    # classifier_version). The plugin renders this as a hex chip when no
    # person-level rating exists. Suggested_rating == 0 is "no signal" and
    # the plugin treats it the same as None.
    suggested_rating: int | None = None
    suggestion_confidence: float | None = None
    suggestion_reason: str | None = None
    suggestion_scored_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_RESOLVE_SQL_TEMPLATE = """
SELECT
    m.id           AS warehouse_id,
    m.message_id   AS rfc_msgid,
    m.sender_addr  AS sender_addr,
    m.received_date AS received_date,
    COALESCE(mc.cluster_id, sc.cluster_id) AS cluster_id,
    COALESCE(mc.cluster,   sc.cluster)     AS cluster_name,
    COALESCE(sc.priority_friend, 0)        AS priority_friend,
    cs.importance_score AS importance_score,
    cs.tldr_text        AS tldr_text,
    cs.reason           AS reason,
    cs.scored_at        AS scored_at,
    mc.classified_at    AS classified_at,
    rs.suggested_rating  AS suggested_rating,
    rs.confidence        AS suggestion_confidence,
    rs.reason            AS suggestion_reason,
    rs.scored_at         AS suggestion_scored_at,
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
    )                  AS to_me_addr,
    (SELECT mr.rating
     FROM message_ratings mr
     WHERE mr.message_id = m.id
     ORDER BY mr.rated_at DESC, mr.id DESC
     LIMIT 1)           AS manual_message_rating
FROM messages m
LEFT JOIN message_classifications mc ON mc.message_id = m.id
LEFT JOIN sender_classifications  sc ON LOWER(sc.sender_addr) = LOWER(m.sender_addr)
LEFT JOIN (
    SELECT message_id, importance_score, tldr_text, reason, scored_at
    FROM content_scores
    WHERE id IN (
        SELECT MAX(id) FROM content_scores GROUP BY message_id
    )
) cs ON cs.message_id = m.id
LEFT JOIN (
    SELECT message_id, suggested_rating, confidence, reason, scored_at
    FROM rating_suggestions
    WHERE classifier_version = ?
      AND id IN (
        SELECT MAX(id) FROM rating_suggestions
        WHERE classifier_version = ?
        GROUP BY message_id
      )
) rs ON rs.message_id = m.id
WHERE m.message_id IN ({placeholders})
"""


def resolve_thread(rfc_message_ids: list[str]) -> ThreadState:
    """Aggregate ThreadState for the given RFC-822 Message-IDs."""
    cleaned = [mid.strip() for mid in rfc_message_ids if mid and mid.strip()]
    if not cleaned:
        return _empty_state()

    placeholders = ",".join("?" * len(cleaned))
    sql = _RESOLVE_SQL_TEMPLATE.format(placeholders=placeholders)
    classifier_version = config.RATING_CLASSIFIER_VERSION
    params = [classifier_version, classifier_version, *cleaned]
    with db.read_only() as con:
        rows = con.execute(sql, params).fetchall()

    if not rows:
        return _empty_state()

    # Aggregate.
    max_rating: int | None = None
    max_rating_source: str | None = None
    most_recent_cluster_id: int | None = None
    most_recent_cluster_name: str | None = None
    most_recent_classified_at: str | None = None
    top_score: float | None = None
    top_tldr: str | None = None
    top_reason: str | None = None
    top_scored_at: str | None = None
    # to_me_addr: pick the one from the most-recently-received message
    # in the thread that had a mark-address recipient.
    latest_me_addr: str | None = None
    latest_me_addr_received: str | None = None
    # Latest LLM rating suggestion across the thread, by scored_at.
    latest_suggested_rating: int | None = None
    latest_suggestion_confidence: float | None = None
    latest_suggestion_reason: str | None = None
    latest_suggestion_scored_at: str | None = None

    for r in rows:
        sender = r["sender_addr"]
        cluster_id = r["cluster_id"]
        priority_friend = bool(r["priority_friend"] or 0)
        manual_mr = r["manual_message_rating"]
        decision = ratings.effective_rating_decision(
            sender_addr=sender,
            cluster_id=cluster_id,
            priority_friend=priority_friend,
            manual_message_rating=(int(manual_mr) if manual_mr is not None else None),
        )
        rating = decision.rating
        if max_rating is None or rating > max_rating:
            max_rating = rating
            max_rating_source = decision.source.value

        classified_at = r["classified_at"]
        if classified_at and (most_recent_classified_at is None
                              or classified_at > most_recent_classified_at):
            most_recent_classified_at = classified_at
            most_recent_cluster_id = cluster_id
            most_recent_cluster_name = r["cluster_name"]

        score = r["importance_score"]
        if score is not None and (top_score is None or score > top_score):
            top_score = float(score)
            top_tldr = r["tldr_text"]
            top_reason = r["reason"]
            top_scored_at = r["scored_at"]

        # Track latest owner-recipient
        msg_me_addr = r["to_me_addr"]
        msg_received = r["received_date"]
        if msg_me_addr and (
            latest_me_addr_received is None
            or (msg_received is not None and msg_received > latest_me_addr_received)
        ):
            latest_me_addr = msg_me_addr
            latest_me_addr_received = msg_received

        # Track latest LLM rating suggestion by scored_at.
        suggested = r["suggested_rating"]
        suggestion_scored_at = r["suggestion_scored_at"]
        if suggested is not None and (
            latest_suggestion_scored_at is None
            or (suggestion_scored_at is not None
                and suggestion_scored_at > latest_suggestion_scored_at)
        ):
            latest_suggested_rating = int(suggested)
            conf = r["suggestion_confidence"]
            latest_suggestion_confidence = (
                float(conf) if conf is not None else None
            )
            latest_suggestion_reason = r["suggestion_reason"]
            latest_suggestion_scored_at = suggestion_scored_at

    # If no message was classified at all, fall back to the first row's cluster.
    if most_recent_cluster_id is None:
        most_recent_cluster_id = rows[0]["cluster_id"]
        most_recent_cluster_name = rows[0]["cluster_name"]

    return ThreadState(
        rating=max_rating,
        cluster_id=most_recent_cluster_id,
        cluster_name=most_recent_cluster_name,
        importance_score=top_score,
        tldr_text=top_tldr,
        reason=top_reason,
        scored_at=top_scored_at,
        matched_message_count=len(rows),
        to_me_addr=latest_me_addr,
        rating_source=max_rating_source,
        suggested_rating=latest_suggested_rating,
        suggestion_confidence=latest_suggestion_confidence,
        suggestion_reason=latest_suggestion_reason,
        suggestion_scored_at=latest_suggestion_scored_at,
    )


def _empty_state() -> ThreadState:
    return ThreadState(
        rating=None,
        cluster_id=None,
        cluster_name=None,
        importance_score=None,
        tldr_text=None,
        reason=None,
        scored_at=None,
        matched_message_count=0,
    )
