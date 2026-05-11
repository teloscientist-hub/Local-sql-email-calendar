"""Mine `routing_corrections` for stable sender→folder patterns.

A "stable" pattern is a sender address that the owner has routed to the SAME
folder N or more times (default 3) with no contradictions (no `accepted_folder`
disagreements for the same sender). The intuition: once the owner has confirmed
the same sender always belongs in folder X, the LLM call is redundant — a
Mailspring mail rule would auto-route it without involving Claude.

Output: a printable table + an optional JSON dump pasteable into a
Mailspring DevTools snippet that calls `Actions.addMailRule` per row.

CLI:
    python -m mml_classifier.promote_corrections                 # default scan
    python -m mml_classifier.promote_corrections --min-count 5   # stricter
    python -m mml_classifier.promote_corrections --since-days 14 # recent only
    python -m mml_classifier.promote_corrections --json          # JSON output
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass

from . import db

log = logging.getLogger(__name__)


@dataclass
class Pattern:
    sender_addr: str
    folder: str
    count: int
    distinct_subjects: int
    sample_subjects: list[str]
    has_contradiction: bool  # True if same sender was routed to different folder elsewhere


_SCAN_SQL = """
SELECT
    LOWER(COALESCE(m.sender_addr, '')) AS sender_addr,
    m.subject                          AS subject,
    rc.accepted_folder                 AS accepted_folder,
    rc.decided_at                      AS decided_at
FROM routing_corrections rc
JOIN messages m ON m.id = rc.message_id
WHERE LENGTH(COALESCE(m.sender_addr, '')) > 0
  AND (? IS NULL OR rc.decided_at >= ?)
ORDER BY rc.decided_at DESC
"""


def scan(*, min_count: int = 3, since_days: int | None = None) -> list[Pattern]:
    since_iso: str | None = None
    if since_days is not None:
        since_iso = (
            dt.datetime.now() - dt.timedelta(days=int(since_days))
        ).isoformat(timespec="seconds")

    # First pass: tally (sender → folder → count + subject samples).
    bucket: dict[str, dict[str, dict]] = defaultdict(
        lambda: defaultdict(lambda: {"count": 0, "subjects": []})
    )
    with db.read_only() as con:
        rows = con.execute(_SCAN_SQL, (since_iso, since_iso)).fetchall()

    for r in rows:
        sender = r["sender_addr"]
        folder = r["accepted_folder"]
        if not sender or not folder:
            continue
        b = bucket[sender][folder]
        b["count"] += 1
        if r["subject"] and len(b["subjects"]) < 3:
            b["subjects"].append(r["subject"])

    # Second pass: identify stable patterns + flag contradictions.
    patterns: list[Pattern] = []
    for sender, folders in bucket.items():
        # Sender has contradictions if 2+ folders received their mail.
        folder_counts = Counter({f: d["count"] for f, d in folders.items()})
        has_contradiction = len(folder_counts) > 1
        # Pick the dominant folder.
        top_folder, top_count = folder_counts.most_common(1)[0]
        if top_count < min_count:
            continue
        b = folders[top_folder]
        patterns.append(Pattern(
            sender_addr=sender,
            folder=top_folder,
            count=top_count,
            distinct_subjects=len(b["subjects"]),
            sample_subjects=list(b["subjects"]),
            has_contradiction=has_contradiction,
        ))

    # Stable patterns first, then by count desc.
    patterns.sort(key=lambda p: (p.has_contradiction, -p.count, p.sender_addr))
    return patterns


def _print_table(patterns: list[Pattern]) -> None:
    if not patterns:
        print("No stable patterns found at the current threshold.")
        return
    print(f"{'COUNT':>6}  {'CONTRADICT':>10}  {'FOLDER':<20}  SENDER")
    print(f"{'-'*6}  {'-'*10}  {'-'*20}  {'-'*40}")
    for p in patterns:
        flag = "yes" if p.has_contradiction else "no"
        print(f"{p.count:>6}  {flag:>10}  {p.folder:<20}  {p.sender_addr}")
        for s in p.sample_subjects[:2]:
            s = (s or "").strip().replace("\n", " ")
            if len(s) > 80:
                s = s[:77] + "..."
            print(f"{'':>6}  {'':>10}  {'':<20}  └─ {s}")
    print()
    stable = [p for p in patterns if not p.has_contradiction]
    contradicted = [p for p in patterns if p.has_contradiction]
    print(f"Total: {len(patterns)} patterns "
          f"({len(stable)} stable, {len(contradicted)} contradicted).")
    if contradicted:
        print("Contradicted patterns route to the dominant folder but other "
              "folders also exist for the same sender — review before promoting.")


def _emit_devtools_snippet(patterns: list[Pattern]) -> None:
    """Print a DevTools-paste snippet for Mailspring that calls
    Actions.addMailRule per stable pattern. Run inside Mailspring's
    DevTools console (Cmd+Option+I) to materialize the rules."""
    stable = [p for p in patterns if not p.has_contradiction]
    if not stable:
        print("// No stable (uncontradicted) patterns to promote.")
        return
    rule_specs = [
        {
            "sender_addr": p.sender_addr,
            "folder_display_name": p.folder,
            "count": p.count,
        }
        for p in stable
    ]
    print(
        "// Paste into Mailspring's DevTools console (Cmd+Option+I) to materialize "
        "these as Mailspring mail rules across BOTH connected accounts. The "
        "snippet adds one rule per (account, pattern) — Mailspring's UI lists "
        "them under Preferences → Mail Rules afterward."
    )
    print()
    print("(() => {")
    print("  const { AccountStore, CategoryStore, Actions, MailRulesTemplates } = "
          "require('mailspring-exports');")
    print("  const specs = " + json.dumps(rule_specs, indent=2) + ";")
    print("  const accounts = AccountStore.accounts();")
    print("  let added = 0, skipped = 0;")
    print("  for (const acc of accounts) {")
    print("    const cats = CategoryStore.categories(acc.id) || [];")
    print("    for (const s of specs) {")
    print("      const dest = cats.find(c => (c.displayName||'') === s.folder_display_name);")
    print("      if (!dest) { skipped++; continue; }")
    print("      const rule = {")
    print("        id: `mml-promote-${s.sender_addr}-${acc.id}`,")
    print("        name: `Auto-route: ${s.sender_addr} → ${s.folder_display_name}`,")
    print("        accountId: acc.id,")
    print("        conditionMode: 'any',")
    print("        conditions: [{ templateKey: 'from', comparatorKey: 'contains', "
          "value: s.sender_addr }],")
    print("        actions: [{")
    print("          templateKey: dest.constructor.name === 'Label' ? "
          "'applyLabel' : 'changeFolder',")
    print("          value: dest.id,")
    print("        }],")
    print("        disabled: false,")
    print("      };")
    print("      Actions.addMailRule(rule);")
    print("      added++;")
    print("    }")
    print("  }")
    print("  return { added, skipped, account_count: accounts.length, "
          "rule_count: specs.length };")
    print("})();")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Mine routing_corrections for stable sender→folder patterns.",
    )
    ap.add_argument("--min-count", type=int, default=3,
                    help="Min times the owner routed to same folder (default 3).")
    ap.add_argument("--since-days", type=int, default=None,
                    help="Only look at corrections within the last N days.")
    ap.add_argument("--json", action="store_true",
                    help="Output JSON instead of the human table.")
    ap.add_argument("--devtools-snippet", action="store_true",
                    help="Emit a DevTools-paste snippet to materialize stable "
                         "patterns as Mailspring mail rules.")
    ap.add_argument("--log-level", default="WARNING",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    patterns = scan(min_count=args.min_count, since_days=args.since_days)

    if args.json:
        print(json.dumps([asdict(p) for p in patterns], indent=2))
        return 0
    if args.devtools_snippet:
        _emit_devtools_snippet(patterns)
        return 0
    _print_table(patterns)
    return 0


if __name__ == "__main__":
    sys.exit(main())
