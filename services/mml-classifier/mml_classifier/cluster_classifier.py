"""Real-time 38-cluster classifier (Phase 4.5).

Mirror of route_classifier.py architecture. The historical Phase 2 batch
classifier wrote `message_classifications` rows for the PST archive; this
module fills the gap for live Mailspring mail by classifying one message
at a time and writing the same table.

The system prompt is the local `prompts/cluster_classify_v1.md` wrapper
concatenated with `email/email_classification_instructions_universal.md`
(the canonical 38-cluster doc), so the doc remains the single source of
truth — edits to it take effect on the next sidecar restart.

CLI:
    python -m mml_classifier.cluster_classifier --message-id 12345
    python -m mml_classifier.cluster_classifier --backfill --limit 200 --concurrency 4
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sqlite3
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from . import claude_cli, config, db

log = logging.getLogger(__name__)


# ---- JSON schema ----------------------------------------------------------

CLUSTER_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "cluster_id": {"type": "integer", "minimum": 1, "maximum": 38},
        "cluster":    {"type": "string"},
        "owner_role":  {"type": "string", "enum": ["sender", "to", "cc", "none"]},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "reason":     {"type": "string"},
    },
    "required": ["cluster_id", "cluster", "confidence"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class ClusterResult:
    message_id: int
    cluster_id: int
    cluster: str
    owner_role: str | None
    confidence: str
    reason: str
    classified_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---- Prompt assembly ------------------------------------------------------

def _load_system_prompt() -> str:
    """Wrapper prompt + the per-deployment cluster taxonomy doc, concatenated."""
    wrapper_path = config.PROMPTS_DIR / f"{config.CLUSTER_PROMPT_VERSION}.md"
    wrapper = wrapper_path.read_text(encoding="utf-8")
    universal_path = config.DATA_ROOT / "email_classification_instructions_universal.md"
    try:
        universal = universal_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        log.warning("cluster doc missing at %s; classifier will run with"
                    " wrapper only and likely under-perform", universal_path)
        return wrapper
    return wrapper + universal


def _format_user_prompt(*, sender_name: str, sender_addr: str,
                        subject: str, body: str | None,
                        recipients_to: list[dict],
                        recipients_cc: list[dict],
                        received_date: str | None) -> str:
    body = (body or "").strip()
    if len(body) > config.CLUSTER_BODY_MAX_CHARS:
        # Phase 2 used head+tail; for real-time single calls a simple truncate
        # is sufficient — most classification signal is in the first 3-5k chars.
        body = body[: config.CLUSTER_BODY_MAX_CHARS] + "\n\n[...truncated]"

    import json as _json
    return (
        f"Classify this email.\n\n"
        f"From: {sender_name or '(no name)'} <{sender_addr or '(no address)'}>\n"
        f"Date: {received_date or 'unknown'}\n"
        f"Subject: {subject or '(no subject)'}\n"
        f"To: {_json.dumps(recipients_to)}\n"
        f"Cc: {_json.dumps(recipients_cc)}\n"
        f"\n---\n{body}\n---\n"
    )


# ---- DB helpers -----------------------------------------------------------

_FETCH_MESSAGE_SQL = """
SELECT id,
       COALESCE(sender_name, '')  AS sender_name,
       COALESCE(sender_addr, '')  AS sender_addr,
       COALESCE(subject, '')      AS subject,
       COALESCE(body_plain, '')   AS body,
       received_date              AS received_date
FROM messages
WHERE id = ?
"""

_FETCH_RECIPIENTS_SQL = """
SELECT COALESCE(name, '')  AS name,
       COALESCE(addr, '')  AS addr,
       kind                AS kind
FROM recipients
WHERE message_id = ?
"""

_EXISTING_CLASSIFICATION_SQL = """
SELECT cluster_id, cluster, confidence, reason, classified_at, owner_role
FROM message_classifications
WHERE message_id = ?
"""


def _coerce_cluster_id(value: Any) -> int:
    try:
        cid = int(value)
    except (TypeError, ValueError):
        return 38  # Needs Review
    if cid in (24, 25):
        # Retired clusters per the doc — map to 23 per its guidance.
        return 23
    if cid < 1 or cid > 38:
        return 38
    return cid


# ---- Public API -----------------------------------------------------------

def classify_message(message_id: int, *, force: bool = False) -> ClusterResult | None:
    """Classify one message_id. Returns the existing row's data if a
    classification already exists (and force=False), otherwise calls Claude
    and persists a new row.

    Returns None if the message is not in the warehouse.
    """
    with db.read_only() as con:
        msg = con.execute(_FETCH_MESSAGE_SQL, (message_id,)).fetchone()
        if not msg:
            return None
        if not force:
            existing = con.execute(_EXISTING_CLASSIFICATION_SQL,
                                   (message_id,)).fetchone()
            if existing:
                return ClusterResult(
                    message_id=message_id,
                    cluster_id=int(existing["cluster_id"]),
                    cluster=existing["cluster"],
                    owner_role=existing["owner_role"],
                    confidence=existing["confidence"],
                    reason=existing["reason"] or "",
                    classified_at=existing["classified_at"],
                )
        rec_rows = con.execute(_FETCH_RECIPIENTS_SQL, (message_id,)).fetchall()

    rec_to = [{"name": r["name"], "addr": r["addr"]}
              for r in rec_rows if (r["kind"] or "to").lower() == "to"]
    rec_cc = [{"name": r["name"], "addr": r["addr"]}
              for r in rec_rows if (r["kind"] or "").lower() == "cc"]

    system_prompt = _load_system_prompt()
    user_prompt = _format_user_prompt(
        sender_name=msg["sender_name"],
        sender_addr=msg["sender_addr"],
        subject=msg["subject"],
        body=msg["body"],
        recipients_to=rec_to,
        recipients_cc=rec_cc,
        received_date=msg["received_date"],
    )

    try:
        out = claude_cli.call(
            user_prompt,
            system=system_prompt,
            json_schema=CLUSTER_SCHEMA,
            model=config.CLUSTER_CLASSIFIER_MODEL,
            timeout=config.CLUSTER_CLASSIFIER_TIMEOUT_SECONDS,
        )
    except claude_cli.ClaudeCallError as e:
        log.warning("cluster_classifier: claude call failed for msg %d: %s",
                    message_id, e)
        raise

    cluster_id = _coerce_cluster_id(out.get("cluster_id"))
    cluster_name = str(out.get("cluster") or "Needs Review")[:200]
    confidence = (out.get("confidence") or "low").lower()
    if confidence not in ("high", "medium", "low"):
        confidence = "low"
    reason = str(out.get("reason") or "")[:1000]
    owner_role = out.get("owner_role")
    if owner_role not in ("sender", "to", "cc", "none"):
        owner_role = None
    classified_at = dt.datetime.now().isoformat(timespec="seconds")

    with db.read_write() as con:
        with con:
            if force:
                con.execute(
                    "DELETE FROM message_classifications WHERE message_id = ?",
                    (message_id,),
                )
            con.execute(
                """
                INSERT INTO message_classifications
                    (message_id, cluster_id, cluster, owner_role,
                     confidence, reason, source, classified_at)
                VALUES (?, ?, ?, ?, ?, ?, 'phase2_email', ?)
                """,
                (message_id, cluster_id, cluster_name, owner_role,
                 confidence, reason, classified_at),
            )

    return ClusterResult(
        message_id=message_id,
        cluster_id=cluster_id,
        cluster=cluster_name,
        owner_role=owner_role,
        confidence=confidence,
        reason=reason,
        classified_at=classified_at,
    )


# ---- Backfill -------------------------------------------------------------

_BACKFILL_SQL = """
SELECT m.id AS message_id
FROM messages m
LEFT JOIN message_classifications mc ON mc.message_id = m.id
WHERE mc.id IS NULL
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
        r = classify_message(mid)
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
        rows = con.execute(_BACKFILL_SQL, (since_iso, since_iso, limit)).fetchall()
    candidate_ids = [int(r["message_id"]) for r in rows]
    total = len(candidate_ids)
    log.info("cluster_classifier backfill: %d candidates (since=%s, limit=%d, concurrency=%d)",
             total, since_iso, limit, concurrency)
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
                log.info("cluster backfill progress: %d/%d (classified=%d errors=%d)",
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
                    log.info("cluster backfill progress: %d/%d (classified=%d errors=%d)",
                             done, total, stats.classified, stats.errors)
    log.info("cluster_classifier backfill done: classified=%d skipped=%d errors=%d",
             stats.classified, stats.skipped, stats.errors)
    return stats


# ---- CLI ------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Real-time 38-cluster classifier (Phase 4.5).")
    ap.add_argument("--message-id", type=int,
                    help="Classify exactly one message_id and print the result.")
    ap.add_argument("--force", action="store_true",
                    help="Reclassify even if a row already exists.")
    ap.add_argument("--backfill", action="store_true",
                    help="Classify unclassified messages, newest first.")
    ap.add_argument("--limit", type=int, default=200,
                    help="Max messages per backfill run (default 200).")
    ap.add_argument("--since",
                    help="ISO datetime; only classify mail received on/after.")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="Parallel claude calls during backfill (default 1).")
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    if args.message_id is not None:
        r = classify_message(args.message_id, force=args.force)
        if r is None:
            print(f"message_id {args.message_id} not found in warehouse")
            return 1
        print(r.to_dict())
        return 0

    if args.backfill:
        stats = backfill(since_iso=args.since, limit=args.limit,
                         concurrency=args.concurrency)
        print()
        print("=== CLUSTER BACKFILL COMPLETE ===")
        print(f"classifier_version: {config.CLUSTER_CLASSIFIER_VERSION}")
        print(f"concurrency:        {args.concurrency}")
        print(f"classified:         {stats.classified}")
        print(f"skipped:            {stats.skipped}")
        print(f"errors:             {stats.errors}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
