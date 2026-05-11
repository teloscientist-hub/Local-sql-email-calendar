"""CLI entrypoint to score fall-through messages in batches.

Modes:
    --mode=recent  --hours=72   Score only messages received in the last N hours.
    --mode=historical           Score newest→oldest, resumable. Run repeatedly.

Resume strategy: each run pulls candidates ordered by `received_date DESC`
that don't already have a content_scores row at the current scorer_version.
There is no separate cursor file — `content_scores.scored_at`+`scorer_version`
*are* the cursor.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys

from . import config, content_scorer

log = logging.getLogger(__name__)


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill content scores for fall-through messages.")
    ap.add_argument("--mode", choices=["recent", "historical"], required=True)
    ap.add_argument("--hours", type=int, default=72,
                    help="Only relevant for --mode=recent. Default: 72.")
    ap.add_argument("--limit", type=int, default=1000,
                    help="Max candidates per run. Default: 1000.")
    ap.add_argument("--source-path", default=None,
                    help="Optional provenance string; recorded on each row.")
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    since_iso: str | None = None
    if args.mode == "recent":
        cutoff = dt.datetime.now() - dt.timedelta(hours=args.hours)
        since_iso = cutoff.isoformat(timespec="seconds")
        log.info("backfill mode=recent hours=%d since=%s", args.hours, since_iso)
    else:
        log.info("backfill mode=historical limit=%d", args.limit)

    log.info("scorer_version=%s warehouse=%s",
             config.SCORER_VERSION, config.WAREHOUSE_DB)

    stats = content_scorer.score_batch(
        since_iso=since_iso,
        limit=args.limit,
        source_path=args.source_path,
    )
    print(f"backfill done: scored={stats.scored} errors={stats.errors}")
    return 0 if stats.errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
