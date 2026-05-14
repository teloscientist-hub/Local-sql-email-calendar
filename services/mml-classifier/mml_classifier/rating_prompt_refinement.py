"""Self-refining rating prompt (Phase 6.0.g).

Periodically (or on demand) ask Claude to articulate what the owner's recent
manual ratings reveal about gaps in the current rating prompt, then
materialize the LLM's suggested sender anchors as a new prompt version.
Old versions stay on disk; rollback is a one-line file write.

Scope is conservative compared to the routing analog (Phase 5.5.5):
- ADD sender anchors only. No phrase replacements.
- The 0–9 scale, cluster-default table, override-priority rules, and
  output schema are all locked — the apply step rejects any change to them.

CLI:
    python -m mml_classifier.rating_prompt_refinement              # force a run
    python -m mml_classifier.rating_prompt_refinement --dry-run    # propose only
    python -m mml_classifier.rating_prompt_refinement --rollback   # revert one step
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import fcntl
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from . import claude_cli, config, db

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# JSON schema for the meta-LLM response

REFINEMENT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "new_anchors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sender":     {"type": "string"},
                    "rating":     {"type": "integer", "minimum": 0, "maximum": 9},
                    "note":       {"type": "string"},
                    "evidence":   {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                },
                "required": ["sender", "rating"],
                "additionalProperties": False,
            },
        },
        "no_change_needed_for": {"type": "array", "items": {"type": "string"}},
        "open_questions":       {"type": "array", "items": {"type": "string"}},
        "overall_confidence":   {"type": ["number", "null"], "minimum": 0.0, "maximum": 1.0},
    },
    "required": ["new_anchors"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# Constants used by the apply-step validator

# These section headers MUST exist byte-for-byte in any candidate prompt.
# Anything that drops one is rejected.
_REQUIRED_HEADERS = (
    "# The 0–9 scale",
    "# Inputs you'll receive",
    "# How to think about it",
    "# Output",
)

# Phrases that prove the locked output schema is intact.
_REQUIRED_PHRASES = (
    '"suggested_rating"',
    '"confidence"',
    '"reason"',
)

# Override-priority rules must remain (these are the owner's hard rules).
_REQUIRED_RULES_PHRASES = (
    "`priority_friend` flag",
    "Family (cluster 3)",
)

# Anchors land under this section header, created if missing.
_ANCHORS_SECTION_HEADER = "# Known sender ratings (auto-curated)"


# ---------------------------------------------------------------------------
# Result types

@dataclass
class RatingRefinementResult:
    proposal: dict
    new_prompt_text: str | None
    new_version_name: str | None
    parent_version: str
    deployed: bool
    rejected_reason: str | None
    applied_anchors: int
    dropped_edits: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Reading current state

def _load_current_prompt() -> tuple[str, Path, str]:
    """Returns (text, path, version_name) for the live rating prompt."""
    version = config._read_rating_current_prompt_version()
    path = config.PROMPTS_DIR / f"{version}.md"
    text = path.read_text(encoding="utf-8")
    return text, path, version


def _load_meta_prompt() -> str:
    p = config.PROMPTS_DIR / f"{config.RATING_REFINEMENT_PROMPT_VERSION}.md"
    return p.read_text(encoding="utf-8")


# Joins each manual rating to the LLM's then-current suggestion (latest by
# scored_at <= rated_at). LEFT JOIN so cache-miss ratings still come through.
_RATINGS_CORPUS_SQL = """
SELECT
    LOWER(COALESCE(m.sender_addr, ''))  AS sender_addr,
    COALESCE(m.subject, '')             AS subject,
    COALESCE(m.body_plain, '')          AS body,
    mr.rating                           AS user_rating,
    mr.note                             AS note,
    mr.rated_at                         AS rated_at,
    (SELECT rs.suggested_rating
       FROM rating_suggestions rs
      WHERE rs.message_id = mr.message_id
        AND rs.scored_at <= mr.rated_at
      ORDER BY rs.scored_at DESC, rs.id DESC
      LIMIT 1)                          AS llm_rating,
    (SELECT rs.confidence
       FROM rating_suggestions rs
      WHERE rs.message_id = mr.message_id
        AND rs.scored_at <= mr.rated_at
      ORDER BY rs.scored_at DESC, rs.id DESC
      LIMIT 1)                          AS llm_confidence
FROM message_ratings mr
JOIN messages m ON m.id = mr.message_id
ORDER BY mr.rated_at DESC, mr.id DESC
LIMIT ?
"""


def _load_recent_ratings(limit: int) -> list[dict]:
    with db.read_only() as con:
        rows = con.execute(_RATINGS_CORPUS_SQL, (limit,)).fetchall()
    out = []
    for r in rows:
        body = (r["body"] or "").strip().replace("\n", " ")
        if len(body) > 200:
            body = body[:197] + "..."
        user_rating = r["user_rating"]
        llm_rating = r["llm_rating"]
        if llm_rating is None:
            source = "manual"
        elif int(llm_rating) == int(user_rating):
            source = "accept"
        else:
            source = "override"
        out.append({
            "sender_addr": r["sender_addr"],
            "subject": (r["subject"] or "").strip().replace("\n", " ")[:200],
            "body_snippet": body,
            "user_rating": int(user_rating) if user_rating is not None else None,
            "llm_rating": int(llm_rating) if llm_rating is not None else None,
            "llm_confidence": float(r["llm_confidence"]) if r["llm_confidence"] is not None else None,
            "note": r["note"],
            "source": source,
        })
    return out


def _format_corpus(rows: list[dict]) -> str:
    lines = []
    for c in rows:
        sender = c["sender_addr"] or "(no addr)"
        subj = c["subject"] or "(no subject)"
        body = c["body_snippet"] or ""
        llm_rating = c["llm_rating"]
        llm_conf = c["llm_confidence"]
        llm_part = (f"llm={llm_rating} conf={llm_conf:.2f}"
                    if llm_rating is not None and llm_conf is not None
                    else (f"llm={llm_rating}" if llm_rating is not None else "llm=—"))
        note = (c["note"] or "").strip()
        user_part = (f"user={c['user_rating']}" + (f" (note: {note})" if note else ""))
        src = c["source"]
        line = (f"- [{src.upper():<8}] {sender}  |  {subj}  |  body: {body}  "
                f"|  {llm_part}  |  {user_part}")
        lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Meta-call

def _call_meta(*, current_prompt: str, corpus_rows: list[dict],
               model: str, timeout: int) -> dict:
    meta_system = _load_meta_prompt()
    corpus = _format_corpus(corpus_rows)
    current_version = config._read_rating_current_prompt_version()
    user_prompt = (
        f"# CURRENT RATING PROMPT ({current_version})\n\n"
        "```markdown\n"
        f"{current_prompt}\n"
        "```\n\n"
        f"# RECENT RATINGS CORPUS ({len(corpus_rows)} rows)\n\n"
        f"{corpus}\n\n"
        "Return your structured-JSON refinement now."
    )
    return claude_cli.call(
        user_prompt,
        system=meta_system,
        json_schema=REFINEMENT_SCHEMA,
        model=model,
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# Apply edits

def _next_version_name(current: str) -> str:
    """`rating_suggest_v1` → `rating_suggest_v2`. Falls back to appending `_r1`."""
    m = re.match(r"^(?P<base>.*_v)(?P<num>\d+)$", current)
    if not m:
        return f"{current}_r1"
    return f"{m.group('base')}{int(m.group('num')) + 1}"


def _sanitize_sender(s: str) -> str:
    """Normalize an LLM-proposed sender string. Strip leading backticks/quotes
    and trim. Empty result → caller drops the anchor."""
    s = (s or "").strip()
    s = s.strip("`'\"")
    s = s.strip()
    return s


_ANCHORS_HEADER_RE = re.compile(
    r"(?P<header>" + re.escape(_ANCHORS_SECTION_HEADER) + r"[^\n]*\n.*?)(?=\n#\s|\Z)",
    re.DOTALL,
)


def _apply_anchors(prompt: str, anchors: list[dict],
                   dropped: list[str]) -> tuple[str, int]:
    """Append each valid anchor under `# Known sender ratings (auto-curated)`.

    Creates the section if missing. Returns (new_prompt, applied_count).
    """
    valid: list[tuple[str, int, str]] = []
    for a in anchors:
        sender = _sanitize_sender(a.get("sender") or "")
        rating = a.get("rating")
        note = (a.get("note") or "").strip()
        if not sender:
            dropped.append("anchor: empty sender")
            continue
        if not isinstance(rating, int) or not (0 <= rating <= 9):
            dropped.append(f"anchor: invalid rating {rating!r} for {sender!r}")
            continue
        # Skip duplicates if the sender already appears under the anchors
        # section verbatim (lightweight check — exact-match only).
        if f"`{sender}`" in prompt and _ANCHORS_SECTION_HEADER in prompt:
            # Only check inside the anchors section.
            m = _ANCHORS_HEADER_RE.search(prompt)
            if m and f"`{sender}`" in m.group("header"):
                dropped.append(f"anchor: sender {sender!r} already anchored")
                continue
        valid.append((sender, rating, note))
    if not valid:
        return prompt, 0

    today = dt.datetime.now().strftime("%Y-%m-%d")
    new_lines = [
        f"- `{sender}` — rating {rating}"
        + (f", {note}" if note else "")
        + f" *(added by refinement on {today})*"
        for sender, rating, note in valid
    ]
    addition = "\n".join(new_lines)

    m = _ANCHORS_HEADER_RE.search(prompt)
    if m:
        # Append inside the existing section, before the next # heading or EOF.
        block = m.group("header").rstrip()
        new_block = block + "\n" + addition + "\n"
        new_prompt = prompt[:m.start()] + new_block + prompt[m.end():]
    else:
        # Section missing — create it at the end of the doc.
        section = (
            "\n\n" + _ANCHORS_SECTION_HEADER + "\n\n"
            "Concrete sender-level or domain-level rating overrides mined from "
            "the owner's recent manual decisions. Treat these as ground-truth: when "
            "an inbound email matches an anchor, return the anchor's rating "
            "with high confidence and cite it in `reason`.\n\n"
            + addition + "\n"
        )
        new_prompt = prompt.rstrip() + section
    return new_prompt, len(valid)


def _validate_candidate(prompt: str) -> str | None:
    """Return a rejection reason if the prompt is malformed, else None."""
    for header in _REQUIRED_HEADERS:
        if header not in prompt:
            return f"missing required section header: {header!r}"
    for phrase in _REQUIRED_PHRASES:
        if phrase not in prompt:
            return f"missing locked output-schema field: {phrase!r}"
    for phrase in _REQUIRED_RULES_PHRASES:
        if phrase not in prompt:
            return f"missing locked override-priority phrase: {phrase!r}"
    return None


# ---------------------------------------------------------------------------
# Atomic version-pointer write

def _write_current_version(version: str) -> None:
    target = config._RATING_CURRENT_VERSION_FILE
    tmp = target.with_suffix(".txt.tmp")
    tmp.write_text(version + "\n", encoding="utf-8")
    tmp.replace(target)


def _record_run(*, version: str, prompt_path: Path, parent_version: str,
                proposal: dict, model: str, count: int,
                deployed_at: str | None) -> None:
    with db.read_write() as con:
        with con:
            con.execute(
                """
                INSERT INTO rating_prompt_versions
                    (version, prompt_path, parent_version, refinement_meta_json,
                     refinement_model, correction_count_at_trigger,
                     created_at, deployed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version,
                    str(prompt_path),
                    parent_version,
                    json.dumps(proposal),
                    model,
                    count,
                    dt.datetime.now().isoformat(timespec="seconds"),
                    deployed_at,
                ),
            )


# ---------------------------------------------------------------------------
# Concurrent-run lock

class _RefinementLock:
    """Process-wide file lock. Non-blocking; raises if already held."""

    def __init__(self):
        self.path = config.PROMPTS_DIR / ".rating_refinement.lock"
        self._fh = None

    def __enter__(self):
        self._fh = open(self.path, "a+")
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError) as e:
            self._fh.close()
            self._fh = None
            raise RuntimeError(f"rating refinement already running: {e}") from e
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._fh:
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            except Exception:  # noqa: BLE001
                pass
            self._fh.close()


# ---------------------------------------------------------------------------
# Public API: refine

def refine(*, dry_run: bool = False) -> RatingRefinementResult:
    """Run one rating-prompt refinement pass. Returns a RatingRefinementResult.

    Raises RuntimeError if another refinement is already running (file lock).
    Never raises on bad LLM output — those become `rejected_reason`.
    """
    current_prompt, current_path, current_version = _load_current_prompt()
    corpus_rows = _load_recent_ratings(config.RATING_REFINEMENT_RATINGS_WINDOW)
    log.info("rating refinement: %d ratings loaded; calling meta-LLM (model=%s)",
             len(corpus_rows), config.RATING_REFINEMENT_MODEL)

    proposal: dict
    try:
        proposal = _call_meta(
            current_prompt=current_prompt,
            corpus_rows=corpus_rows,
            model=config.RATING_REFINEMENT_MODEL,
            timeout=config.RATING_REFINEMENT_TIMEOUT_SECONDS,
        )
    except claude_cli.ClaudeCallError as e:
        log.error("rating refinement: meta-LLM call failed: %s", e)
        return RatingRefinementResult(
            proposal={}, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason=f"meta-LLM call failed: {e}",
            applied_anchors=0, dropped_edits=[],
        )

    new_anchors = proposal.get("new_anchors") or []
    log.info("rating refinement: meta-LLM returned %d new anchors",
             len(new_anchors))

    if not new_anchors:
        log.info("rating refinement: no edits proposed; nothing to deploy")
        if not dry_run:
            try:
                _record_run(
                    version=f"{current_version}_noop_{int(dt.datetime.now().timestamp())}",
                    prompt_path=current_path,
                    parent_version=current_version,
                    proposal=proposal,
                    model=config.RATING_REFINEMENT_MODEL,
                    count=len(corpus_rows),
                    deployed_at=None,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("rating refinement: failed to record noop run: %s", e)
        return RatingRefinementResult(
            proposal=proposal, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason="no edits proposed",
            applied_anchors=0, dropped_edits=[],
        )

    dropped: list[str] = []
    candidate, n_anchors = _apply_anchors(current_prompt, new_anchors, dropped)

    if n_anchors == 0:
        return RatingRefinementResult(
            proposal=proposal, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason=f"all edits dropped during apply: {dropped[:5]}",
            applied_anchors=0, dropped_edits=dropped,
        )

    rejection = _validate_candidate(candidate)
    if rejection:
        rej_dir = config.PROMPTS_DIR / "_rejected"
        rej_dir.mkdir(exist_ok=True)
        ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        rej_path = rej_dir / f"{ts}_{_next_version_name(current_version)}.md"
        rej_path.write_text(candidate, encoding="utf-8")
        log.error("rating refinement: candidate REJECTED (%s); written to %s",
                  rejection, rej_path)
        return RatingRefinementResult(
            proposal=proposal, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason=rejection,
            applied_anchors=0, dropped_edits=dropped,
        )

    new_version = _next_version_name(current_version)
    new_path = config.PROMPTS_DIR / f"{new_version}.md"

    if dry_run:
        log.info("rating refinement: DRY-RUN — not writing %s", new_path)
        return RatingRefinementResult(
            proposal=proposal, new_prompt_text=candidate, new_version_name=new_version,
            parent_version=current_version, deployed=False,
            rejected_reason=None,
            applied_anchors=n_anchors,
            dropped_edits=dropped,
        )

    new_path.write_text(candidate, encoding="utf-8")
    _write_current_version(new_version)
    deployed_at = dt.datetime.now().isoformat(timespec="seconds")
    _record_run(
        version=new_version, prompt_path=new_path,
        parent_version=current_version, proposal=proposal,
        model=config.RATING_REFINEMENT_MODEL,
        count=len(corpus_rows), deployed_at=deployed_at,
    )
    log.info("rating refinement: DEPLOYED %s (anchors=%d, dropped=%d)",
             new_version, n_anchors, len(dropped))
    return RatingRefinementResult(
        proposal=proposal, new_prompt_text=candidate, new_version_name=new_version,
        parent_version=current_version, deployed=True,
        rejected_reason=None,
        applied_anchors=n_anchors,
        dropped_edits=dropped,
    )


def rollback() -> tuple[str, str]:
    """Roll back to the parent of the current version, per the audit trail."""
    current_version = config._read_rating_current_prompt_version()
    with db.read_only() as con:
        r = con.execute(
            "SELECT parent_version FROM rating_prompt_versions "
            "WHERE version = ? AND deployed_at IS NOT NULL "
            "ORDER BY id DESC LIMIT 1",
            (current_version,),
        ).fetchone()
    if not r or not r["parent_version"]:
        raise RuntimeError(
            f"no deployed parent for {current_version!r} — nothing to roll back"
        )
    target = r["parent_version"]
    target_path = config.PROMPTS_DIR / f"{target}.md"
    if not target_path.exists():
        raise RuntimeError(
            f"parent prompt file {target_path} does not exist; manual recovery needed"
        )
    _write_current_version(target)
    return current_version, target


# ---------------------------------------------------------------------------
# CLI

def _print_diff(old: str, new: str) -> None:
    diff = difflib.unified_diff(
        old.splitlines(keepends=True),
        new.splitlines(keepends=True),
        fromfile="current",
        tofile="proposed",
        n=2,
    )
    sys.stdout.write("".join(diff))


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Self-refining rating prompt — analyze recent manual "
                    "ratings and propose/apply sender-anchor additions.",
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="Print proposed anchors + diff; don't write files.")
    ap.add_argument("--rollback", action="store_true",
                    help="Roll back to the parent of the current prompt version.")
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

    if args.rollback:
        try:
            old, new = rollback()
        except RuntimeError as e:
            print(f"rollback failed: {e}", file=sys.stderr)
            return 2
        print(f"rolled back: {old} → {new}")
        return 0

    try:
        with _RefinementLock():
            result = refine(dry_run=args.dry_run)
    except RuntimeError as e:
        print(f"lock: {e}", file=sys.stderr)
        return 1

    if args.dry_run:
        print("=== RATING REFINEMENT (DRY-RUN) ===")
    else:
        print("=== RATING REFINEMENT RUN ===")
    print(f"parent_version: {result.parent_version}")
    print(f"applied_anchors: {result.applied_anchors}")
    print(f"dropped_edits: {len(result.dropped_edits)}")
    for d in result.dropped_edits[:10]:
        print(f"  - {d}")
    if result.rejected_reason:
        print(f"rejected: {result.rejected_reason}")
    if result.new_version_name:
        print(f"new_version: {result.new_version_name}  deployed={result.deployed}")
    print()
    print("PROPOSAL:")
    print(json.dumps(result.proposal, indent=2)[:4000])
    if args.dry_run and result.new_prompt_text:
        print()
        print("DIFF:")
        current, _, _ = _load_current_prompt()
        _print_diff(current, result.new_prompt_text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
