"""Body-read content scoring for fall-through clusters.

Pulls candidate messages (cluster IN {29,30,31}, no recent content_scores row),
calls Claude on subject + body, parses {importance_score, tldr_text, reason},
appends a row to content_scores with full provenance.
"""

from __future__ import annotations

import datetime as dt
import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from . import claude_cli, config, db

log = logging.getLogger(__name__)


# ---- JSON schema ----------------------------------------------------------

CONTENT_SCORE_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "importance_score": {"type": "number", "minimum": 0.0, "maximum": 1.0},
        "tldr_text": {"type": ["string", "null"]},
        "reason": {"type": "string"},
    },
    "required": ["importance_score", "reason"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class Candidate:
    message_id: int
    subject: str
    sender_name: str
    sender_addr: str
    body: str
    received_date: str | None
    cluster_id: int
    cluster_name: str


@dataclass(frozen=True)
class ScoreResult:
    importance_score: float
    tldr_text: str | None
    reason: str


# ---- Loaders -------------------------------------------------------------

def _load_system_prompt() -> str:
    path = config.PROMPTS_DIR / f"{config.SCORER_PROMPT_VERSION}.md"
    return path.read_text(encoding="utf-8")


def _format_user_prompt(c: Candidate) -> str:
    body = (c.body or "").strip()
    if len(body) > config.BODY_MAX_CHARS:
        body = body[: config.BODY_MAX_CHARS] + "\n\n[...truncated]"
    return (
        f"From: {c.sender_name} <{c.sender_addr}>\n"
        f"Date: {c.received_date or 'unknown'}\n"
        f"Cluster: {c.cluster_name} (id={c.cluster_id})\n"
        f"Subject: {c.subject}\n"
        f"\n"
        f"---\n"
        f"{body}\n"
        f"---\n"
    )


# ---- Candidate query ------------------------------------------------------

# Fall-through messages in the warehouse that DON'T already have a content_scores
# row at the current scorer_version. Order: most recent first. The optional
# `since_iso` clamps to a recent window (used by --mode=recent backfill).

_CANDIDATE_SQL = """
SELECT
    m.id            AS message_id,
    m.subject       AS subject,
    COALESCE(m.sender_name, '') AS sender_name,
    COALESCE(m.sender_addr, '') AS sender_addr,
    COALESCE(m.body_plain, '')  AS body,
    m.received_date AS received_date,
    mc.cluster_id   AS cluster_id,
    mc.cluster      AS cluster_name
FROM messages m
JOIN message_classifications mc ON mc.message_id = m.id
LEFT JOIN content_scores cs
       ON cs.message_id = m.id
      AND cs.scorer_version = ?
WHERE mc.cluster_id IN (29, 30, 31)
  AND cs.id IS NULL
  AND COALESCE(m.tombstone, 0) = 0
  AND (? IS NULL OR m.received_date >= ?)
ORDER BY m.received_date DESC
LIMIT ?
"""


def iter_candidates(*, since_iso: str | None = None, limit: int = 1000) -> Iterator[Candidate]:
    with db.read_only() as con:
        rows = con.execute(
            _CANDIDATE_SQL,
            (config.SCORER_VERSION, since_iso, since_iso, limit),
        ).fetchall()
    for r in rows:
        yield Candidate(
            message_id=r["message_id"],
            subject=r["subject"] or "(no subject)",
            sender_name=r["sender_name"],
            sender_addr=r["sender_addr"],
            body=r["body"],
            received_date=r["received_date"],
            cluster_id=r["cluster_id"],
            cluster_name=r["cluster_name"],
        )


# ---- Scoring loop ---------------------------------------------------------

def score_candidate(c: Candidate, *, system_prompt: str) -> ScoreResult:
    user_prompt = _format_user_prompt(c)
    out = claude_cli.call(
        user_prompt,
        system=system_prompt,
        json_schema=CONTENT_SCORE_SCHEMA,
    )
    score = float(out["importance_score"])
    score = max(0.0, min(1.0, score))
    tldr = out.get("tldr_text")
    reason = str(out.get("reason", ""))[:1000]
    return ScoreResult(importance_score=score, tldr_text=tldr, reason=reason)


def write_score(con: sqlite3.Connection, message_id: int, result: ScoreResult,
                source_path: str | None = None) -> None:
    con.execute(
        """
        INSERT INTO content_scores
            (message_id, importance_score, tldr_text, reason,
             scorer_version, scored_at, source_path, ingester_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message_id,
            result.importance_score,
            result.tldr_text,
            result.reason,
            config.SCORER_VERSION,
            dt.datetime.now().isoformat(timespec="seconds"),
            source_path,
            config.INGESTER_VERSION,
        ),
    )


@dataclass
class RunStats:
    scored: int = 0
    skipped: int = 0
    errors: int = 0


def score_batch(*, since_iso: str | None = None, limit: int = 1000,
                source_path: str | None = None) -> RunStats:
    """Score up to `limit` unscored fall-through candidates and return stats."""
    system_prompt = _load_system_prompt()
    stats = RunStats()
    candidates = list(iter_candidates(since_iso=since_iso, limit=limit))
    log.info("score_batch: %d candidates (since=%s, limit=%d)",
             len(candidates), since_iso, limit)

    with db.read_write() as con:
        for c in candidates:
            try:
                result = score_candidate(c, system_prompt=system_prompt)
            except claude_cli.ClaudeCallError as e:
                log.error("claude failure for message_id=%d: %s", c.message_id, e)
                stats.errors += 1
                continue
            except Exception as e:  # noqa: BLE001
                log.error("unexpected failure scoring message_id=%d: %s",
                          c.message_id, e, exc_info=True)
                stats.errors += 1
                continue
            try:
                with con:
                    write_score(con, c.message_id, result, source_path=source_path)
                stats.scored += 1
            except sqlite3.Error as e:
                log.error("DB write failed for message_id=%d: %s", c.message_id, e)
                stats.errors += 1

    log.info("score_batch done: scored=%d errors=%d", stats.scored, stats.errors)
    return stats


def score_message_ids(message_ids: list[int]) -> RunStats:
    """Score a specific set of warehouse message IDs (used by /score-now)."""
    if not message_ids:
        return RunStats()
    system_prompt = _load_system_prompt()
    stats = RunStats()

    placeholders = ",".join("?" * len(message_ids))
    sql = f"""
        SELECT m.id AS message_id, m.subject, COALESCE(m.sender_name,'') AS sender_name,
               COALESCE(m.sender_addr,'') AS sender_addr, COALESCE(m.body_plain,'') AS body,
               m.received_date, mc.cluster_id, mc.cluster AS cluster_name
        FROM messages m
        JOIN message_classifications mc ON mc.message_id = m.id
        LEFT JOIN content_scores cs
               ON cs.message_id = m.id AND cs.scorer_version = ?
        WHERE m.id IN ({placeholders})
          AND mc.cluster_id IN (29, 30, 31)
          AND cs.id IS NULL
    """
    with db.read_only() as con:
        rows = con.execute(sql, [config.SCORER_VERSION, *message_ids]).fetchall()

    candidates = [
        Candidate(
            message_id=r["message_id"],
            subject=r["subject"] or "(no subject)",
            sender_name=r["sender_name"],
            sender_addr=r["sender_addr"],
            body=r["body"],
            received_date=r["received_date"],
            cluster_id=r["cluster_id"],
            cluster_name=r["cluster_name"],
        )
        for r in rows
    ]
    stats.skipped = len(message_ids) - len(candidates)

    with db.read_write() as con:
        for c in candidates:
            try:
                result = score_candidate(c, system_prompt=system_prompt)
                with con:
                    write_score(con, c.message_id, result)
                stats.scored += 1
            except Exception as e:  # noqa: BLE001
                log.error("score-now failure for message_id=%d: %s", c.message_id, e)
                stats.errors += 1
    return stats
