"""Taxonomy generator — derive a personalized cluster taxonomy from your
own warehouse.

The cluster_classifier expects a `email_classification_instructions_universal.md`
document that defines the cluster set, the auto-rules, and the
disambiguation guidance. Rather than ship a template-author's clusters,
this tool reads YOUR warehouse, samples representative messages, and asks
Claude to propose a 20-40 cluster taxonomy that fits your actual life and
work patterns.

CLI:
    # Propose a starter taxonomy from your warehouse
    python -m tools.taxonomy_generator --propose --sample 500 --years 5

    # Re-roll with different sampling parameters
    python -m tools.taxonomy_generator --propose --sample 800 --years 3 \
        --output email_classification_instructions_universal.draft.md

    # Print sample-only (no LLM call) — useful for inspecting what would
    # be sent to the model:
    python -m tools.taxonomy_generator --sample 500 --dry-run

After review, save the draft as `email/email_classification_instructions_universal.md`
(the location your `cluster_classifier.py` reads from) and run the cluster
backfill: `python -m mml_classifier.cluster_classifier --backfill --limit 200`.

Prerequisites:
- Warehouse populated via the PST/IMAP pipeline (so `messages.subject` and
  `messages.body_plain` are reasonably full).
- `claude` CLI available (or set MML_CLASSIFIER_CLAUDE_CLI).
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import random
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Add services/mml-classifier to sys.path so we can reuse claude_cli + config.
_HERE = Path(__file__).resolve().parent
_SIDECAR = _HERE.parent / "services" / "mml-classifier"
sys.path.insert(0, str(_SIDECAR))

from mml_classifier import claude_cli, config, db  # noqa: E402

log = logging.getLogger(__name__)


META_PROMPT_PATH = _SIDECAR / "mml_classifier" / "prompts" / "taxonomy_meta_v1.md"
DEFAULT_OUTPUT = Path("email_classification_instructions_universal.draft.md")


@dataclass(frozen=True)
class SampledMessage:
    sender_addr: str
    sender_name: str
    subject: str
    body_excerpt: str
    received_year: int | None
    folder_path: str | None


# ---------------------------------------------------------------------------
# Sampling

_STRATIFIED_SQL = """
WITH stratified AS (
    SELECT
        m.id,
        COALESCE(m.sender_addr, '')   AS sender_addr,
        COALESCE(m.sender_name, '')   AS sender_name,
        COALESCE(m.subject, '')       AS subject,
        COALESCE(m.body_plain, '')    AS body,
        m.received_date               AS received_date,
        (SELECT path FROM folders f WHERE f.id = m.folder_id LIMIT 1) AS folder_path,
        ROW_NUMBER() OVER (
            PARTITION BY LOWER(COALESCE(m.sender_addr, ''))
            ORDER BY RANDOM()
        ) AS rank_within_sender
    FROM messages m
    WHERE COALESCE(m.tombstone, 0) = 0
      AND LENGTH(COALESCE(m.subject, '')) > 0
      AND (? IS NULL OR m.received_date >= ?)
)
SELECT id, sender_addr, sender_name, subject, body, received_date, folder_path
FROM stratified
WHERE rank_within_sender <= 3   -- at most 3 per distinct sender for diversity
ORDER BY RANDOM()
LIMIT ?
"""


def _sample(*, limit: int, years: int | None) -> list[SampledMessage]:
    since_iso: str | None = None
    if years is not None and years > 0:
        cutoff = dt.datetime.now() - dt.timedelta(days=365 * int(years))
        since_iso = cutoff.isoformat(timespec="seconds")
    with db.read_only() as con:
        rows = con.execute(_STRATIFIED_SQL, (since_iso, since_iso, limit)).fetchall()
    out: list[SampledMessage] = []
    for r in rows:
        body = (r["body"] or "").strip().replace("\n", " ")
        if len(body) > 400:
            body = body[:397] + "..."
        year: int | None = None
        rd = r["received_date"]
        if isinstance(rd, str) and len(rd) >= 4 and rd[:4].isdigit():
            year = int(rd[:4])
        out.append(SampledMessage(
            sender_addr=r["sender_addr"],
            sender_name=r["sender_name"],
            subject=(r["subject"] or "").strip().replace("\n", " ")[:200],
            body_excerpt=body,
            received_year=year,
            folder_path=r["folder_path"],
        ))
    return out


def _format_sample(messages: list[SampledMessage]) -> str:
    """Format sampled messages as a numbered list for the meta-prompt."""
    lines = []
    for i, m in enumerate(messages, 1):
        sender = f"{m.sender_name} <{m.sender_addr}>".strip() if m.sender_name else (m.sender_addr or "(no sender)")
        year = f"{m.received_year}" if m.received_year else "?"
        folder = f" [folder: {m.folder_path}]" if m.folder_path else ""
        lines.append(
            f"{i:>3}. {year} | from: {sender}{folder}\n"
            f"     subj: {m.subject}\n"
            f"     body: {m.body_excerpt}"
        )
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# LLM call

# Lightweight schema — the cluster doc is markdown, not JSON.
_PROPOSAL_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "cluster_count":   {"type": "integer", "minimum": 5, "maximum": 60},
        "summary":         {"type": "string"},
        "taxonomy_markdown": {"type": "string"},
        "open_questions":  {"type": "array", "items": {"type": "string"}},
    },
    "required": ["cluster_count", "taxonomy_markdown"],
    "additionalProperties": False,
}


def _call_meta(*, sample_block: str, model: str, timeout: int) -> dict:
    system_prompt = META_PROMPT_PATH.read_text(encoding="utf-8")
    user_prompt = (
        "Here is a stratified random sample of the user's email archive. "
        "Each entry is one message. Propose a personalized cluster taxonomy that "
        "fits THIS user's life and work patterns.\n\n"
        f"# Sample ({sample_block.count(chr(10) + chr(10)) + 1} messages)\n\n"
        f"{sample_block}\n\n"
        "Now return your structured proposal."
    )
    return claude_cli.call(
        user_prompt,
        system=system_prompt,
        json_schema=_PROPOSAL_SCHEMA,
        model=model,
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# CLI

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Propose a personalized cluster taxonomy from your warehouse.",
    )
    ap.add_argument("--propose", action="store_true",
                    help="Sample messages and call the LLM to propose a taxonomy.")
    ap.add_argument("--sample", type=int, default=500,
                    help="Number of messages to sample (default 500).")
    ap.add_argument("--years", type=int, default=5,
                    help="Only sample messages from the last N years (default 5).")
    ap.add_argument("--output", type=str, default=str(DEFAULT_OUTPUT),
                    help="Where to write the proposed taxonomy draft.")
    ap.add_argument("--model", default="sonnet",
                    help="Claude model alias (default 'sonnet'; haiku is faster/cheaper but less analytical).")
    ap.add_argument("--timeout", type=int, default=300,
                    help="Per-LLM-call timeout in seconds (default 300; this is a big call).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the sample only; no LLM call, no output file.")
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    log.info("sampling %d messages from the last %d year(s)...", args.sample, args.years)
    messages = _sample(limit=args.sample, years=args.years)
    if len(messages) == 0:
        print("warehouse appears empty or has no messages matching the window. "
              "Run the PST/IMAP intake pipeline first.", file=sys.stderr)
        return 1

    sample_block = _format_sample(messages)
    log.info("sampled %d messages; sample block is %d chars",
             len(messages), len(sample_block))

    if args.dry_run:
        print("=== DRY-RUN — sample only ===")
        print(sample_block[:2000] + ("..." if len(sample_block) > 2000 else ""))
        print(f"\n(truncated; full sample is {len(sample_block):,} chars)")
        return 0

    if not args.propose:
        ap.print_help()
        print("\nNo action requested. Use --propose to call the LLM and write a draft.",
              file=sys.stderr)
        return 0

    log.info("calling claude (model=%s, timeout=%ds)...", args.model, args.timeout)
    try:
        out = _call_meta(sample_block=sample_block, model=args.model, timeout=args.timeout)
    except claude_cli.ClaudeCallError as e:
        print(f"claude call failed: {e}", file=sys.stderr)
        return 2

    taxonomy_md = out.get("taxonomy_markdown", "")
    cluster_count = out.get("cluster_count")
    summary = out.get("summary") or ""
    open_qs = out.get("open_questions") or []

    output_path = Path(args.output).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Prepend a header noting provenance.
    header = (
        f"<!-- Generated by tools/taxonomy_generator.py on "
        f"{dt.datetime.now().isoformat(timespec='seconds')}\n"
        f"     sample_size={len(messages)}  years={args.years}  "
        f"model={args.model}  cluster_count={cluster_count}\n"
        f"\n"
        f"     Review this draft, edit as needed, then save (or rename) to\n"
        f"       email/email_classification_instructions_universal.md\n"
        f"     for the cluster_classifier to pick it up. -->\n\n"
    )
    output_path.write_text(header + taxonomy_md, encoding="utf-8")
    print(f"wrote draft taxonomy to {output_path}")
    print(f"cluster count: {cluster_count}")
    if summary:
        print(f"summary: {summary}")
    if open_qs:
        print("open questions:")
        for q in open_qs:
            print(f"  - {q}")
    print()
    print("Next steps:")
    print(f"  1. Review and edit {output_path}")
    print(f"  2. Save as email/email_classification_instructions_universal.md")
    print(f"  3. python -m mml_classifier.cluster_classifier --backfill --limit 50")
    return 0


if __name__ == "__main__":
    sys.exit(main())
