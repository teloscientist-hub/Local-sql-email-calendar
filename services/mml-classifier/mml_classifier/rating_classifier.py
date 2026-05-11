"""LLM rating suggester (Phase 6.0).

Suggests a 0-9 rating for one message, mirroring route_classifier.py's
architecture. Output persists to `rating_suggestions` (append-only).

In-context learning: every classification call appends the owner's last ~50
manual ratings (from `message_ratings`, including any `note` they typed via
the Ctrl+Option+N overlay) to the system prompt as ground-truth few-shot
examples. Notes explain *why* they rated — when present, the LLM uses them
to generalize the reasoning to similar future mail.

The rating classifier is decoupled from the "show this to the owner" decision:
the plugin already renders the PersonBand pill only for person-level
sources. The LLM's suggestion is a SUGGESTION, available for plugin chip
rendering and for downstream rating refinement; it does NOT auto-write
to message_ratings.

CLI:
    python -m mml_classifier.rating_classifier --message-id 12345
    python -m mml_classifier.rating_classifier --backfill --limit 200 --concurrency 4
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sqlite3
import sys
from dataclasses import asdict, dataclass
from typing import Any

from . import claude_cli, config, db

log = logging.getLogger(__name__)


# ---- JSON schema ----------------------------------------------------------

RATING_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "suggested_rating": {"type": "integer", "minimum": 0, "maximum": 9},
        "confidence":       {"type": ["number", "null"], "minimum": 0.0, "maximum": 1.0},
        "reason":           {"type": "string"},
    },
    "required": ["suggested_rating", "reason"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class RatingSuggestion:
    message_id: int
    suggested_rating: int
    confidence: float | None
    reason: str
    classifier_version: str
    scored_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _empty_suggestion() -> dict[str, Any]:
    return {
        "message_id": None,
        "suggested_rating": None,
        "confidence": None,
        "reason": None,
        "classifier_version": None,
        "scored_at": None,
    }


# ---- Loaders -------------------------------------------------------------

def _load_system_prompt_base() -> str:
    path = config.PROMPTS_DIR / f"{config.RATING_PROMPT_VERSION}.md"
    return path.read_text(encoding="utf-8")


_FEW_SHOT_SQL = """
SELECT
    COALESCE(m.sender_addr, '')  AS sender_addr,
    COALESCE(m.subject, '')      AS subject,
    COALESCE(m.body_plain, '')   AS body,
    mr.rating                    AS rating,
    mr.note                      AS note,
    mr.rated_at                  AS rated_at
FROM message_ratings mr
JOIN messages m ON m.id = mr.message_id
ORDER BY mr.rated_at DESC, mr.id DESC
LIMIT ?
"""


def _load_few_shot_block() -> str:
    """Build a system-prompt block of recent (sender, subject, body, rating, note)
    tuples. Empty string if feature disabled or no rows."""
    limit = int(config.RATING_CORRECTIONS_FEW_SHOT_LIMIT or 0)
    if limit <= 0:
        return ""
    try:
        with db.read_only() as con:
            rows = con.execute(_FEW_SHOT_SQL, (limit,)).fetchall()
    except Exception as e:  # noqa: BLE001
        log.warning("rating_classifier: couldn't load few-shot rows: %s", e)
        return ""
    if not rows:
        return ""
    lines = []
    for r in rows:
        sender = r["sender_addr"] or "(no addr)"
        subj = (r["subject"] or "").strip().replace("\n", " ")
        if len(subj) > 80:
            subj = subj[:77] + "…"
        body = (r["body"] or "").strip().replace("\n", " ")
        if len(body) > 120:
            body = body[:117] + "…"
        note = (r["note"] or "").strip().replace("\n", " ")
        suffix = f' (note: "{note}")' if note else ""
        lines.append(f"- {sender}  |  {subj}  |  body: {body}  →  rating={r['rating']}{suffix}")
    return (
        "\n\n# Recent manual ratings (ground truth, treat as authoritative)\n\n"
        "These are real ratings the owner assigned via Ctrl+Option+<digit>. Each line "
        "is `sender | subject | body-snippet → rating (note: why)` where the note "
        "may be present or absent. When an incoming email closely resembles one of "
        "these in sender, subject, or content, **strongly prefer the same rating**. "
        "If a note explains the reasoning, generalize that reasoning to similar mail.\n\n"
        + "\n".join(lines) + "\n"
    )


_FETCH_MESSAGE_SQL = """
SELECT m.id                                          AS id,
       COALESCE(m.sender_name, '')                   AS sender_name,
       COALESCE(m.sender_addr, '')                   AS sender_addr,
       COALESCE(m.subject, '')                       AS subject,
       COALESCE(m.body_plain, '')                    AS body,
       m.received_date                               AS received_date,
       COALESCE(mc.cluster_id, sc.cluster_id)        AS cluster_id,
       COALESCE(mc.cluster,    sc.cluster)           AS cluster_name,
       COALESCE(sc.priority_friend, 0)               AS priority_friend
FROM messages m
LEFT JOIN message_classifications mc ON mc.message_id = m.id
LEFT JOIN sender_classifications  sc ON LOWER(sc.sender_addr) = LOWER(m.sender_addr)
WHERE m.id = ?
"""


def _format_user_prompt(*, sender_name: str, sender_addr: str,
                        subject: str, body: str, received_date: str | None,
                        cluster_id: int | None, cluster_name: str | None,
                        priority_friend: bool) -> str:
    body = (body or "").strip()
    if len(body) > config.RATING_BODY_MAX_CHARS:
        body = body[: config.RATING_BODY_MAX_CHARS] + "\n\n[...truncated]"
    cluster_line = (
        f"Cluster: {cluster_id} {cluster_name}\n" if cluster_id is not None
        else "Cluster: (unclassified)\n"
    )
    flag_line = "Flags: priority_friend\n" if priority_friend else ""
    return (
        f"From: {sender_name or '(no name)'} <{sender_addr or '(no address)'}>\n"
        f"Date: {received_date or 'unknown'}\n"
        f"{cluster_line}"
        f"{flag_line}"
        f"Subject: {subject or '(no subject)'}\n"
        f"\n---\n{body}\n---\n"
    )


# ---- DB helpers ----------------------------------------------------------

_FETCH_CACHED_SQL = """
SELECT id, message_id, suggested_rating, confidence, reason,
       classifier_version, scored_at
FROM rating_suggestions
WHERE message_id = ?
  AND classifier_version = ?
ORDER BY scored_at DESC, id DESC
LIMIT 1
"""


def _row_to_suggestion(r: sqlite3.Row) -> RatingSuggestion:
    return RatingSuggestion(
        message_id=int(r["message_id"]),
        suggested_rating=int(r["suggested_rating"]),
        confidence=(None if r["confidence"] is None else float(r["confidence"])),
        reason=r["reason"] or "",
        classifier_version=r["classifier_version"],
        scored_at=r["scored_at"],
    )


def _clamp_rating(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(9, n))


# ---- Public API ----------------------------------------------------------

def suggest_for_message(message_id: int, *, cached_only: bool = False) -> RatingSuggestion | None:
    """Return cached or freshly-computed rating suggestion for one message.

    Returns None if message not in warehouse.
    cached_only=True: never call LLM; return cached row at current version or None.
    """
    with db.read_only() as con:
        cached = con.execute(
            _FETCH_CACHED_SQL,
            (message_id, config.RATING_CLASSIFIER_VERSION),
        ).fetchone()
        if cached:
            return _row_to_suggestion(cached)
        if cached_only:
            return None
        msg = con.execute(_FETCH_MESSAGE_SQL, (message_id,)).fetchone()
        if not msg:
            return None

    system_prompt = _load_system_prompt_base() + _load_few_shot_block()
    user_prompt = _format_user_prompt(
        sender_name=msg["sender_name"],
        sender_addr=msg["sender_addr"],
        subject=msg["subject"],
        body=msg["body"],
        received_date=msg["received_date"],
        cluster_id=(int(msg["cluster_id"]) if msg["cluster_id"] is not None else None),
        cluster_name=msg["cluster_name"],
        priority_friend=bool(msg["priority_friend"]),
    )

    try:
        out = claude_cli.call(
            user_prompt,
            system=system_prompt,
            json_schema=RATING_SCHEMA,
            model=config.RATING_CLASSIFIER_MODEL,
            timeout=config.RATING_CLASSIFIER_TIMEOUT_SECONDS,
        )
    except claude_cli.ClaudeCallError as e:
        log.warning("rating_classifier: claude call failed for msg %d: %s",
                    message_id, e)
        raise

    rating = _clamp_rating(out.get("suggested_rating"))
    conf_raw = out.get("confidence")
    confidence = (max(0.0, min(1.0, float(conf_raw)))
                  if isinstance(conf_raw, (int, float)) else None)
    reason = str(out.get("reason", ""))[:1000]
    scored_at = dt.datetime.now().isoformat(timespec="seconds")

    with db.read_write() as con:
        with con:
            con.execute(
                """
                INSERT INTO rating_suggestions
                    (message_id, suggested_rating, confidence, reason,
                     classifier_version, scored_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (message_id, rating, confidence, reason,
                 config.RATING_CLASSIFIER_VERSION, scored_at),
            )

    return RatingSuggestion(
        message_id=message_id,
        suggested_rating=rating,
        confidence=confidence,
        reason=reason,
        classifier_version=config.RATING_CLASSIFIER_VERSION,
        scored_at=scored_at,
    )


# ---- Backfill ------------------------------------------------------------

_BACKFILL_SQL = """
SELECT m.id AS message_id
FROM messages m
LEFT JOIN rating_suggestions rs
       ON rs.message_id = m.id
      AND rs.classifier_version = ?
WHERE rs.id IS NULL
  AND COALESCE(m.tombstone, 0) = 0
  AND (? IS NULL OR m.received_date >= ?)
ORDER BY m.received_date DESC, m.id DESC
LIMIT ?
"""


@dataclass
class BackfillStats:
    classified: int = 0
    skipped: int = 0
    errors: int = 0


def _classify_one(mid: int) -> tuple[int, str]:
    try:
        r = suggest_for_message(mid)
        return (mid, "classified" if r is not None else "skipped")
    except claude_cli.ClaudeCallError as e:
        log.warning("backfill: claude failure for msg %d: %s", mid, e)
        return (mid, "error")
    except Exception as e:  # noqa: BLE001
        log.exception("backfill: unexpected failure for msg %d: %s", mid, e)
        return (mid, "error")


def backfill(*, since_iso: str | None = None, limit: int = 500,
             concurrency: int = 1, progress_every: int = 10) -> BackfillStats:
    import concurrent.futures as _cf
    stats = BackfillStats()
    with db.read_only() as con:
        rows = con.execute(
            _BACKFILL_SQL,
            (config.RATING_CLASSIFIER_VERSION, since_iso, since_iso, limit),
        ).fetchall()
    candidate_ids = [int(r["message_id"]) for r in rows]
    total = len(candidate_ids)
    log.info("rating_classifier backfill: %d candidates (since=%s, limit=%d, concurrency=%d, version=%s)",
             total, since_iso, limit, concurrency, config.RATING_CLASSIFIER_VERSION)
    if total == 0:
        return stats
    done = 0
    concurrency = max(1, int(concurrency))
    if concurrency == 1:
        for mid in candidate_ids:
            _, outcome = _classify_one(mid)
            if outcome == "classified": stats.classified += 1
            elif outcome == "skipped": stats.skipped += 1
            else: stats.errors += 1
            done += 1
            if progress_every and done % progress_every == 0:
                log.info("rating backfill progress: %d/%d (classified=%d errors=%d)",
                         done, total, stats.classified, stats.errors)
    else:
        with _cf.ThreadPoolExecutor(max_workers=concurrency) as ex:
            futures = {ex.submit(_classify_one, mid): mid for mid in candidate_ids}
            for fut in _cf.as_completed(futures):
                _, outcome = fut.result()
                if outcome == "classified": stats.classified += 1
                elif outcome == "skipped": stats.skipped += 1
                else: stats.errors += 1
                done += 1
                if progress_every and done % progress_every == 0:
                    log.info("rating backfill progress: %d/%d (classified=%d errors=%d)",
                             done, total, stats.classified, stats.errors)
    log.info("rating_classifier backfill done: classified=%d skipped=%d errors=%d",
             stats.classified, stats.skipped, stats.errors)
    return stats


# ---- CLI -----------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="LLM rating suggester (Phase 6.0).")
    ap.add_argument("--message-id", type=int,
                    help="Suggest a rating for one message_id and print it.")
    ap.add_argument("--backfill", action="store_true",
                    help="Suggest ratings for unclassified messages.")
    ap.add_argument("--limit", type=int, default=200,
                    help="Max messages per backfill run.")
    ap.add_argument("--since",
                    help="ISO datetime; only process mail received on/after.")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="Parallel claude calls (default 1).")
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    if args.message_id is not None:
        r = suggest_for_message(args.message_id)
        if r is None:
            print(f"message_id {args.message_id} not found")
            return 1
        print(r.to_dict())
        return 0
    if args.backfill:
        stats = backfill(since_iso=args.since, limit=args.limit,
                         concurrency=args.concurrency)
        print()
        print("=== RATING BACKFILL COMPLETE ===")
        print(f"classifier_version: {config.RATING_CLASSIFIER_VERSION}")
        print(f"concurrency:        {args.concurrency}")
        print(f"classified:         {stats.classified}")
        print(f"skipped:            {stats.skipped}")
        print(f"errors:             {stats.errors}")
        return 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
