"""LLM routing suggestions for the 8 Routed/<name> folders.

`suggest_for_message(message_id)` returns a cached suggestion if one exists
at the current classifier version, otherwise calls Claude on sender+subject,
persists to routing_suggestions, and returns the new row.

`record_correction(...)` is a thin write helper for routing_corrections.

Append-only on both sides — re-classification (prompt-version bump) inserts
a new suggestion row; current per message = MAX(scored_at).
"""

from __future__ import annotations

import datetime as dt
import logging
import sqlite3
from dataclasses import asdict, dataclass
from typing import Any

from . import claude_cli, config, db

log = logging.getLogger(__name__)


# ---- JSON schema ----------------------------------------------------------

# Valid folder names plus the literal 'none'. The schema doesn't enforce
# membership in the 8-folder set (the LLM might output something quirky we
# want to capture verbatim for debugging) — server-side, we coerce unknown
# values into 'none' and let the user override.
ROUTING_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "suggested_folder": {"type": "string"},
        "confidence": {"type": ["number", "null"], "minimum": 0.0, "maximum": 1.0},
        "reason": {"type": "string"},
    },
    "required": ["suggested_folder", "reason"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class RouteSuggestion:
    message_id: int
    suggested_folder: str
    confidence: float | None
    reason: str
    classifier_version: str
    scored_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _empty_suggestion() -> dict[str, Any]:
    return {
        "message_id": None,
        "suggested_folder": None,
        "confidence": None,
        "reason": None,
        "classifier_version": None,
        "scored_at": None,
    }


# ---- Loaders -------------------------------------------------------------

def _load_system_prompt() -> str:
    path = config.PROMPTS_DIR / f"{config.ROUTING_PROMPT_VERSION}.md"
    return path.read_text(encoding="utf-8")


def _format_user_prompt(*, sender_name: str, sender_addr: str, subject: str,
                       body: str | None = None) -> str:
    body = (body or "").strip()
    if len(body) > config.ROUTING_BODY_MAX_CHARS:
        body = body[: config.ROUTING_BODY_MAX_CHARS] + "\n\n[...truncated]"
    if not body:
        return (
            f"From: {sender_name or '(no name)'} <{sender_addr or '(no address)'}>\n"
            f"Subject: {subject or '(no subject)'}\n"
        )
    return (
        f"From: {sender_name or '(no name)'} <{sender_addr or '(no address)'}>\n"
        f"Subject: {subject or '(no subject)'}\n"
        f"\n"
        f"---\n"
        f"{body}\n"
        f"---\n"
    )


# Recent corrections injected as few-shot examples.

_RECENT_CORRECTIONS_SQL = """
SELECT
    COALESCE(m.sender_addr, '')  AS sender_addr,
    COALESCE(m.sender_name, '')  AS sender_name,
    COALESCE(m.subject, '')      AS subject,
    rc.accepted_folder           AS accepted_folder,
    rc.suggested_folder          AS suggested_folder,
    rc.source                    AS source,
    rc.decided_at                AS decided_at
FROM routing_corrections rc
JOIN messages m ON m.id = rc.message_id
ORDER BY rc.decided_at DESC, rc.id DESC
LIMIT ?
"""


def _load_recent_corrections_block() -> str:
    """Return a system-prompt-ready block summarizing the owner's recent
    routing decisions. Empty string if no corrections or feature off."""
    limit = int(config.ROUTING_CORRECTIONS_FEW_SHOT_LIMIT or 0)
    if limit <= 0:
        return ""
    try:
        with db.read_only() as con:
            rows = con.execute(_RECENT_CORRECTIONS_SQL, (limit,)).fetchall()
    except Exception as e:  # noqa: BLE001
        log.warning("route_classifier: couldn't load recent corrections: %s", e)
        return ""
    if not rows:
        return ""
    lines = []
    for r in rows:
        sender = r["sender_addr"] or "(no addr)"
        subj = (r["subject"] or "").strip().replace("\n", " ")
        if len(subj) > 80:
            subj = subj[:77] + "…"
        folder = r["accepted_folder"]
        source = r["source"]
        # Tag the example with the source so the LLM knows whether the owner
        # actively disagreed (override) or confirmed (accept) or simply
        # routed without prior suggestion (manual).
        lines.append(f"- {sender}  |  {subj}  →  {folder}  ({source})")
    return (
        "\n\n# Recent routing decisions (treat as ground truth)\n\n"
        "These are the most recent routing decisions the owner made manually. "
        "Each line is `sender | subject → folder (source)`. `source=accept` "
        "means the owner agreed with a prior LLM suggestion; `override` means they "
        "disagreed and picked their own; `manual` means they routed without an "
        "LLM suggestion in play. **When an incoming email closely resembles "
        "one of these in sender or subject, prefer the same folder.**\n\n"
        + "\n".join(lines) + "\n"
    )


# ---- DB helpers ----------------------------------------------------------

_FETCH_CACHED_SQL = """
SELECT id, message_id, suggested_folder, confidence, reason,
       classifier_version, scored_at
FROM routing_suggestions
WHERE message_id = ?
  AND classifier_version = ?
ORDER BY scored_at DESC, id DESC
LIMIT 1
"""

_FETCH_MESSAGE_SQL = """
SELECT id,
       COALESCE(sender_name, '') AS sender_name,
       COALESCE(sender_addr, '') AS sender_addr,
       COALESCE(subject, '')     AS subject,
       COALESCE(body_plain, '')  AS body
FROM messages
WHERE id = ?
"""


def _row_to_suggestion(r: sqlite3.Row) -> RouteSuggestion:
    return RouteSuggestion(
        message_id=int(r["message_id"]),
        suggested_folder=r["suggested_folder"],
        confidence=(None if r["confidence"] is None else float(r["confidence"])),
        reason=r["reason"] or "",
        classifier_version=r["classifier_version"],
        scored_at=r["scored_at"],
    )


def _coerce_folder(value: str) -> str:
    """Map LLM output into our known set; unknown values → 'none'."""
    if not isinstance(value, str):
        return "none"
    cleaned = value.strip()
    if cleaned == "none":
        return "none"
    if cleaned in config.ROUTING_FOLDERS:
        return cleaned
    # Be forgiving about case + a missing 'Routed/' prefix from the LLM.
    lower = cleaned.lower()
    for f in config.ROUTING_FOLDERS:
        if f.lower() == lower:
            return f
        suffix = f.split("/", 1)[1] if "/" in f else f
        if suffix.lower() == lower:
            return f
    return "none"


# ---- Public API -----------------------------------------------------------

def suggest_for_message(message_id: int, *, cached_only: bool = False) -> RouteSuggestion | None:
    """Return a cached or freshly-computed suggestion for one message_id.

    Returns None if the message_id does not exist in `messages`.
    If `cached_only=True`, never call the LLM — return the cached row at
    the current classifier_version, or None if no cache hit. Used by the
    plugin's keystroke path so the UI is instant.
    """
    with db.read_only() as con:
        cached = con.execute(
            _FETCH_CACHED_SQL,
            (message_id, config.ROUTING_CLASSIFIER_VERSION),
        ).fetchone()
        if cached:
            return _row_to_suggestion(cached)

        if cached_only:
            return None

        msg = con.execute(_FETCH_MESSAGE_SQL, (message_id,)).fetchone()
        if not msg:
            return None

    sender_name = msg["sender_name"]
    sender_addr = msg["sender_addr"]
    subject = msg["subject"]
    body = msg["body"]

    system_prompt = _load_system_prompt() + _load_recent_corrections_block()
    user_prompt = _format_user_prompt(
        sender_name=sender_name, sender_addr=sender_addr, subject=subject,
        body=body,
    )

    try:
        out = claude_cli.call(
            user_prompt,
            system=system_prompt,
            json_schema=ROUTING_SCHEMA,
        )
    except claude_cli.ClaudeCallError as e:
        log.warning("route_classifier: claude call failed for msg %d: %s",
                    message_id, e)
        raise

    folder = _coerce_folder(out.get("suggested_folder", "none"))
    conf_raw = out.get("confidence")
    confidence: float | None
    if isinstance(conf_raw, (int, float)):
        confidence = max(0.0, min(1.0, float(conf_raw)))
    else:
        confidence = None
    reason = str(out.get("reason", ""))[:1000]
    scored_at = dt.datetime.now().isoformat(timespec="seconds")

    with db.read_write() as con:
        with con:
            con.execute(
                """
                INSERT INTO routing_suggestions
                    (message_id, suggested_folder, confidence, reason,
                     classifier_version, scored_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (message_id, folder, confidence, reason,
                 config.ROUTING_CLASSIFIER_VERSION, scored_at),
            )

    return RouteSuggestion(
        message_id=message_id,
        suggested_folder=folder,
        confidence=confidence,
        reason=reason,
        classifier_version=config.ROUTING_CLASSIFIER_VERSION,
        scored_at=scored_at,
    )


def latest_suggestion(message_id: int) -> RouteSuggestion | None:
    """Cheap lookup — no LLM call, returns the most recent cached suggestion
    for this message regardless of classifier_version. Used by the override
    path: we want to record the suggestion the user actually saw on screen,
    even if a version bump has invalidated the strict cache match."""
    sql = """
    SELECT id, message_id, suggested_folder, confidence, reason,
           classifier_version, scored_at
    FROM routing_suggestions
    WHERE message_id = ?
    ORDER BY scored_at DESC, id DESC
    LIMIT 1
    """
    with db.read_only() as con:
        r = con.execute(sql, (message_id,)).fetchone()
    return _row_to_suggestion(r) if r else None


@dataclass(frozen=True)
class CorrectionResult:
    correction_id: int
    decided_at: str
    source: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---- Backfill -------------------------------------------------------------

# Candidates for classification: messages that don't have a row in
# routing_suggestions at the CURRENT classifier_version. Newest first so a
# partial run still covers the owner's most-recent mail.
_BACKFILL_SQL = """
SELECT m.id AS message_id
FROM messages m
LEFT JOIN routing_suggestions rs
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
    """Worker: classify one message_id. Returns (mid, outcome)."""
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
    """Classify up to `limit` unclassified messages at the current classifier_version.

    Newest first. Each classification is one Claude CLI call (~$0.04 warm,
    ~$0.13 cold). With `concurrency > 1`, runs that many claude calls in
    parallel (each is a separate CLI subprocess; total wall time drops
    linearly until you hit Anthropic rate limits).
    """
    import concurrent.futures as _cf

    stats = BackfillStats()
    with db.read_only() as con:
        rows = con.execute(
            _BACKFILL_SQL,
            (config.ROUTING_CLASSIFIER_VERSION, since_iso, since_iso, limit),
        ).fetchall()
    candidate_ids = [int(r["message_id"]) for r in rows]
    total = len(candidate_ids)
    log.info(
        "route_classifier backfill: %d candidates (since=%s, limit=%d, "
        "version=%s, concurrency=%d)",
        total, since_iso, limit, config.ROUTING_CLASSIFIER_VERSION, concurrency,
    )
    if total == 0:
        return stats

    done = 0
    concurrency = max(1, int(concurrency))
    if concurrency == 1:
        for mid in candidate_ids:
            _, outcome = _classify_one(mid)
            if outcome == "classified":
                stats.classified += 1
            elif outcome == "skipped":
                stats.skipped += 1
            else:
                stats.errors += 1
            done += 1
            if progress_every and done % progress_every == 0:
                log.info("backfill progress: %d/%d (classified=%d errors=%d)",
                         done, total, stats.classified, stats.errors)
    else:
        with _cf.ThreadPoolExecutor(max_workers=concurrency) as ex:
            futures = {ex.submit(_classify_one, mid): mid for mid in candidate_ids}
            for fut in _cf.as_completed(futures):
                _, outcome = fut.result()
                if outcome == "classified":
                    stats.classified += 1
                elif outcome == "skipped":
                    stats.skipped += 1
                else:
                    stats.errors += 1
                done += 1
                if progress_every and done % progress_every == 0:
                    log.info("backfill progress: %d/%d (classified=%d errors=%d)",
                             done, total, stats.classified, stats.errors)

    log.info(
        "route_classifier backfill done: classified=%d skipped=%d errors=%d",
        stats.classified, stats.skipped, stats.errors,
    )
    return stats


def record_correction(
    *,
    message_id: int,
    suggested_folder: str | None,
    accepted_folder: str,
    source: str,
    plugin_version: str | None = None,
    classifier_version: str | None = None,
) -> CorrectionResult:
    """Append a routing_corrections row.

    `source` must be one of {'accept', 'override', 'manual'}.
    """
    if source not in ("accept", "override", "manual"):
        raise ValueError(f"unknown source: {source!r}")
    if not isinstance(accepted_folder, str) or not accepted_folder:
        raise ValueError("accepted_folder must be a non-empty string")
    decided_at = dt.datetime.now().isoformat(timespec="seconds")

    with db.read_write() as con:
        with con:
            cur = con.execute(
                """
                INSERT INTO routing_corrections
                    (message_id, suggested_folder, accepted_folder, source,
                     classifier_version, plugin_version, decided_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (message_id, suggested_folder, accepted_folder, source,
                 classifier_version, plugin_version, decided_at),
            )
            correction_id = int(cur.lastrowid)

    return CorrectionResult(
        correction_id=correction_id,
        decided_at=decided_at,
        source=source,
    )


# ---- CLI ------------------------------------------------------------------

def main() -> int:
    import argparse
    import sys

    ap = argparse.ArgumentParser(
        description="Routing classifier — backfill / one-off classify.",
    )
    sub = ap.add_subparsers(dest="cmd", required=False)

    ap.add_argument("--backfill", action="store_true",
                    help="Classify unclassified messages at the current version.")
    ap.add_argument("--limit", type=int, default=200,
                    help="Max messages to classify in this run (default 200).")
    ap.add_argument("--since",
                    help="ISO 8601 datetime; only classify messages received on/after.")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="Parallel claude calls during --backfill (default 1; try 4-8).")
    ap.add_argument("--message-id", type=int,
                    help="Classify exactly one message_id and print the result.")
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
            print(f"message_id {args.message_id} not found in warehouse")
            return 1
        print(f"{r.to_dict()}")
        return 0

    if args.backfill:
        stats = backfill(since_iso=args.since, limit=args.limit,
                         concurrency=args.concurrency)
        print()
        print("=== ROUTING BACKFILL COMPLETE ===")
        print(f"classifier_version: {config.ROUTING_CLASSIFIER_VERSION}")
        print(f"concurrency:        {args.concurrency}")
        print(f"classified:         {stats.classified}")
        print(f"skipped:            {stats.skipped}")
        print(f"errors:             {stats.errors}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
