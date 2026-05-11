"""Self-refining routing prompt.

Periodically (or on demand) ask Claude to articulate what the owner's recent
routing corrections reveal about gaps in the current routing prompt, then
materialize the LLM's suggested edits as a new prompt version. Old versions
stay on disk; rollback is a one-line file write.

CLI:
    python -m mml_classifier.prompt_refinement              # force a run
    python -m mml_classifier.prompt_refinement --dry-run    # propose only
    python -m mml_classifier.prompt_refinement --rollback   # revert one step
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
                    "folder":     {"type": "string"},
                    "anchor":     {"type": "string"},
                    "evidence":   {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                },
                "required": ["folder", "anchor"],
                "additionalProperties": False,
            },
        },
        "definition_refinements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "folder":          {"type": "string"},
                    "current_phrase":  {"type": "string"},
                    "proposed_phrase": {"type": "string"},
                    "rationale":       {"type": "string"},
                    "evidence":        {"type": "string"},
                    "confidence":      {"type": "number", "minimum": 0.0, "maximum": 1.0},
                },
                "required": ["folder", "current_phrase", "proposed_phrase"],
                "additionalProperties": False,
            },
        },
        "no_change_needed_for": {"type": "array", "items": {"type": "string"}},
        "open_questions":       {"type": "array", "items": {"type": "string"}},
        "overall_confidence":   {"type": ["number", "null"], "minimum": 0.0, "maximum": 1.0},
    },
    "required": ["new_anchors", "definition_refinements"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# Constants used by the apply-step validator

# These section headers MUST exist byte-for-byte in any candidate prompt.
# A candidate that's missing one of them is rejected and quarantined.
_REQUIRED_HEADERS = (
    "# Decision rules",
    "# Output format",
    "# The folders",
    "# Known signals",
)

# Sets of folder names the LLM is allowed to reference. Anchors / refinements
# for any other folder are dropped silently. Sourced from config.ROUTING_FOLDERS
# so the two stay in sync when the user customizes their folder taxonomy.
_VALID_FOLDERS = frozenset(config.ROUTING_FOLDERS)


# ---------------------------------------------------------------------------
# Result types

@dataclass
class RefinementResult:
    proposal: dict
    new_prompt_text: str | None
    new_version_name: str | None
    parent_version: str
    deployed: bool
    rejected_reason: str | None
    applied_anchors: int
    applied_definition_refinements: int
    dropped_edits: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Reading current state

def _load_current_prompt() -> tuple[str, Path, str]:
    """Returns (text, path, version_name) for the live prompt."""
    version = config._read_current_prompt_version()
    path = config.PROMPTS_DIR / f"{version}.md"
    text = path.read_text(encoding="utf-8")
    return text, path, version


def _load_meta_prompt() -> str:
    p = config.PROMPTS_DIR / f"{config.ROUTING_REFINEMENT_PROMPT_VERSION}.md"
    return p.read_text(encoding="utf-8")


_CORRECTIONS_SQL = """
SELECT
    LOWER(COALESCE(m.sender_addr, ''))  AS sender_addr,
    COALESCE(m.subject, '')             AS subject,
    COALESCE(m.body_plain, '')          AS body,
    rc.suggested_folder                 AS suggested_folder,
    rc.accepted_folder                  AS accepted_folder,
    rc.source                           AS source,
    rc.decided_at                       AS decided_at
FROM routing_corrections rc
JOIN messages m ON m.id = rc.message_id
ORDER BY rc.decided_at DESC, rc.id DESC
LIMIT ?
"""


def _load_recent_corrections(limit: int) -> list[dict]:
    with db.read_only() as con:
        rows = con.execute(_CORRECTIONS_SQL, (limit,)).fetchall()
    out = []
    for r in rows:
        body = (r["body"] or "").strip().replace("\n", " ")
        if len(body) > 200:
            body = body[:197] + "..."
        out.append({
            "sender_addr": r["sender_addr"],
            "subject": (r["subject"] or "").strip().replace("\n", " ")[:200],
            "body_snippet": body,
            "suggested_folder": r["suggested_folder"],
            "accepted_folder": r["accepted_folder"],
            "source": r["source"],
        })
    return out


def _format_corpus(corrections: list[dict]) -> str:
    lines = []
    for c in corrections:
        sf = c["suggested_folder"] or "—"
        af = c["accepted_folder"]
        src = c["source"]
        sender = c["sender_addr"] or "(no addr)"
        subj = c["subject"] or "(no subject)"
        body = c["body_snippet"] or ""
        # flag overrides loud so the LLM weights them properly
        line = (f"- [{src.upper():<8}] {sender}  |  {subj}  |  body: {body}  "
                f"|  llm={sf}  user={af}")
        lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Meta-call

def _call_meta(*, current_prompt: str, corrections: list[dict],
               model: str, timeout: int) -> dict:
    meta_system = _load_meta_prompt()
    corpus = _format_corpus(corrections)
    user_prompt = (
        "# CURRENT ROUTING PROMPT (route_suggest_v{ver})\n\n"
        "```markdown\n"
        f"{current_prompt}\n"
        "```\n\n"
        f"# RECENT CORRECTIONS ({len(corrections)} rows)\n\n"
        f"{corpus}\n\n"
        "Return your structured-JSON refinement now."
    ).replace("{ver}", config._read_current_prompt_version())
    return claude_cli.call(
        user_prompt,
        system=meta_system,
        json_schema=REFINEMENT_SCHEMA,
        model=model,
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# Apply edits

# Match the entire `# Known signals` section so we can append anchor lines.
_KNOWN_SIGNALS_RE = re.compile(
    r"(?P<header># Known signals[^\n]*\n.*?)(?=\n#\s|\Z)",
    re.DOTALL,
)


def _next_version_name(current: str) -> str:
    """`route_suggest_v4` → `route_suggest_v5`. Falls back to appending `_r1`
    if the current name doesn't end in a version number we can bump."""
    m = re.match(r"^(?P<base>.*_v)(?P<num>\d+)$", current)
    if not m:
        return f"{current}_r1"
    return f"{m.group('base')}{int(m.group('num')) + 1}"


def _apply_anchors(prompt: str, anchors: list[dict],
                   dropped: list[str]) -> tuple[str, int]:
    """Append each valid anchor to the `# Known signals` section as a new line.
    Returns (new_prompt, applied_count)."""
    valid = []
    for a in anchors:
        folder = a.get("folder")
        anchor_text = (a.get("anchor") or "").strip()
        if folder not in _VALID_FOLDERS:
            dropped.append(f"anchor: unknown folder {folder!r}")
            continue
        if not anchor_text:
            dropped.append(f"anchor: empty anchor text for {folder!r}")
            continue
        # Strip a redundant leading "`Routed/<folder>` — " if the LLM put the
        # folder name in the anchor text. We're already going to prepend it.
        anchor_text = re.sub(
            r"^`?Routed/[^`\n]+`?\s*[—–-]\s*",
            "",
            anchor_text,
        ).strip()
        if not anchor_text:
            dropped.append(f"anchor: empty after folder-prefix strip for {folder!r}")
            continue
        # Skip duplicates if the anchor already appears literally.
        if anchor_text in prompt:
            dropped.append(f"anchor: already-present text "
                           f"{anchor_text[:60]!r} for {folder!r}")
            continue
        valid.append((folder, anchor_text))
    if not valid:
        return prompt, 0

    m = _KNOWN_SIGNALS_RE.search(prompt)
    if not m:
        dropped.append("anchor: # Known signals section not found in prompt")
        return prompt, 0
    block = m.group("header")
    addition = "\n".join(
        f"- **`{folder}`** — {text} *(added by refinement on "
        f"{dt.datetime.now().strftime('%Y-%m-%d')})*"
        for folder, text in valid
    )
    # Insert at end of block (before the next # heading or end-of-doc).
    new_block = block.rstrip() + "\n" + addition + "\n"
    new_prompt = prompt[:m.start()] + new_block + prompt[m.end():]
    return new_prompt, len(valid)


def _apply_definition_refinements(prompt: str, edits: list[dict],
                                  dropped: list[str]) -> tuple[str, int]:
    applied = 0
    new_prompt = prompt
    for e in edits:
        folder = e.get("folder")
        current_phrase = e.get("current_phrase") or ""
        proposed_phrase = e.get("proposed_phrase") or ""
        if folder not in _VALID_FOLDERS:
            dropped.append(f"refinement: unknown folder {folder!r}")
            continue
        if not current_phrase or not proposed_phrase:
            dropped.append(f"refinement: empty phrase(s) for {folder!r}")
            continue
        if current_phrase not in new_prompt:
            dropped.append(
                f"refinement: current_phrase not found verbatim for {folder!r}: "
                f"{current_phrase[:80]!r}"
            )
            continue
        # Only allow replacement if the phrase is inside the matching folder's
        # definition section — defined as the text from `## `{folder}`` up to
        # the next `## ` heading. We confirm the substring's position falls
        # within that span.
        section_re = re.compile(
            r"(##\s+`" + re.escape(folder) + r"`.*?)(?=\n##\s|\Z)",
            re.DOTALL,
        )
        m = section_re.search(new_prompt)
        if not m:
            dropped.append(f"refinement: section for {folder!r} not located")
            continue
        section_start, section_end = m.start(), m.end()
        phrase_pos = new_prompt.find(current_phrase)
        if not (section_start <= phrase_pos < section_end):
            dropped.append(
                f"refinement: phrase for {folder!r} found OUTSIDE its definition "
                f"section (pos={phrase_pos}, section={section_start}-{section_end})"
            )
            continue
        # Apply.
        new_prompt = new_prompt.replace(current_phrase, proposed_phrase, 1)
        applied += 1
    return new_prompt, applied


def _validate_candidate(prompt: str) -> str | None:
    """Returns a rejection reason if the prompt is malformed, else None."""
    for header in _REQUIRED_HEADERS:
        if header not in prompt:
            return f"missing required section header: {header!r}"
    # The output-format code fence must still be there.
    if '"suggested_folder"' not in prompt:
        return "output schema field 'suggested_folder' not found"
    if '"reason"' not in prompt:
        return "output schema field 'reason' not found"
    # No folder names should have been renamed away.
    for f in _VALID_FOLDERS:
        if f"`{f}`" not in prompt and f not in prompt:
            return f"folder name {f!r} dropped from prompt"
    return None


# ---------------------------------------------------------------------------
# Atomic version-pointer write

def _write_current_version(version: str) -> None:
    target = config._CURRENT_VERSION_FILE
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
                INSERT INTO routing_prompt_versions
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
        self.path = config.PROMPTS_DIR / ".refinement.lock"
        self._fh = None

    def __enter__(self):
        self._fh = open(self.path, "a+")
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError) as e:
            self._fh.close()
            self._fh = None
            raise RuntimeError(f"refinement already running: {e}") from e
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

def refine(*, dry_run: bool = False) -> RefinementResult:
    """Run one refinement pass. Returns a RefinementResult.

    Raises RuntimeError if another refinement is already running (file lock).
    Never raises on bad LLM output — those become `rejected_reason`.
    """
    current_prompt, current_path, current_version = _load_current_prompt()
    corrections = _load_recent_corrections(config.ROUTING_REFINEMENT_CORRECTIONS_WINDOW)
    log.info("refinement: %d corrections loaded; calling meta-LLM (model=%s)",
             len(corrections), config.ROUTING_REFINEMENT_MODEL)

    proposal: dict
    try:
        proposal = _call_meta(
            current_prompt=current_prompt,
            corrections=corrections,
            model=config.ROUTING_REFINEMENT_MODEL,
            timeout=config.ROUTING_REFINEMENT_TIMEOUT_SECONDS,
        )
    except claude_cli.ClaudeCallError as e:
        log.error("refinement: meta-LLM call failed: %s", e)
        return RefinementResult(
            proposal={}, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason=f"meta-LLM call failed: {e}",
            applied_anchors=0, applied_definition_refinements=0,
            dropped_edits=[],
        )

    new_anchors = proposal.get("new_anchors") or []
    refinements = proposal.get("definition_refinements") or []
    log.info("refinement: meta-LLM returned %d new anchors, %d refinements",
             len(new_anchors), len(refinements))

    if not new_anchors and not refinements:
        log.info("refinement: no edits proposed; nothing to deploy")
        # Still record an audit row (no deployment) so we can see when runs
        # produced no changes.
        if not dry_run:
            try:
                _record_run(
                    version=f"{current_version}_noop_{int(dt.datetime.now().timestamp())}",
                    prompt_path=current_path,
                    parent_version=current_version,
                    proposal=proposal,
                    model=config.ROUTING_REFINEMENT_MODEL,
                    count=len(corrections),
                    deployed_at=None,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("refinement: failed to record noop run: %s", e)
        return RefinementResult(
            proposal=proposal, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason="no edits proposed",
            applied_anchors=0, applied_definition_refinements=0,
            dropped_edits=[],
        )

    dropped: list[str] = []
    candidate = current_prompt
    candidate, n_anchors = _apply_anchors(candidate, new_anchors, dropped)
    candidate, n_refinements = _apply_definition_refinements(candidate, refinements, dropped)

    if n_anchors == 0 and n_refinements == 0:
        return RefinementResult(
            proposal=proposal, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason=f"all edits dropped during apply: {dropped[:5]}",
            applied_anchors=0, applied_definition_refinements=0,
            dropped_edits=dropped,
        )

    # Validate.
    rejection = _validate_candidate(candidate)
    if rejection:
        # Quarantine for inspection.
        rej_dir = config.PROMPTS_DIR / "_rejected"
        rej_dir.mkdir(exist_ok=True)
        ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        rej_path = rej_dir / f"{ts}_{_next_version_name(current_version)}.md"
        rej_path.write_text(candidate, encoding="utf-8")
        log.error("refinement: candidate REJECTED (%s); written to %s",
                  rejection, rej_path)
        return RefinementResult(
            proposal=proposal, new_prompt_text=None, new_version_name=None,
            parent_version=current_version, deployed=False,
            rejected_reason=rejection,
            applied_anchors=0, applied_definition_refinements=0,
            dropped_edits=dropped,
        )

    new_version = _next_version_name(current_version)
    new_path = config.PROMPTS_DIR / f"{new_version}.md"

    if dry_run:
        log.info("refinement: DRY-RUN — not writing %s", new_path)
        return RefinementResult(
            proposal=proposal, new_prompt_text=candidate, new_version_name=new_version,
            parent_version=current_version, deployed=False,
            rejected_reason=None,
            applied_anchors=n_anchors,
            applied_definition_refinements=n_refinements,
            dropped_edits=dropped,
        )

    # Real deploy.
    new_path.write_text(candidate, encoding="utf-8")
    _write_current_version(new_version)
    deployed_at = dt.datetime.now().isoformat(timespec="seconds")
    _record_run(
        version=new_version, prompt_path=new_path,
        parent_version=current_version, proposal=proposal,
        model=config.ROUTING_REFINEMENT_MODEL,
        count=len(corrections), deployed_at=deployed_at,
    )
    log.info("refinement: DEPLOYED %s (anchors=%d, refinements=%d, dropped=%d)",
             new_version, n_anchors, n_refinements, len(dropped))
    return RefinementResult(
        proposal=proposal, new_prompt_text=candidate, new_version_name=new_version,
        parent_version=current_version, deployed=True,
        rejected_reason=None,
        applied_anchors=n_anchors,
        applied_definition_refinements=n_refinements,
        dropped_edits=dropped,
    )


def rollback() -> tuple[str, str]:
    """Roll back to the parent of the current version, per the audit trail."""
    current_version = config._read_current_prompt_version()
    with db.read_only() as con:
        r = con.execute(
            "SELECT parent_version FROM routing_prompt_versions "
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
        description="Self-refining routing prompt — analyze recent corrections "
                    "and propose/apply prompt edits.",
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="Print proposed edits + diff; don't write files.")
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
        print("=== REFINEMENT (DRY-RUN) ===")
    else:
        print("=== REFINEMENT RUN ===")
    print(f"parent_version: {result.parent_version}")
    print(f"applied_anchors: {result.applied_anchors}")
    print(f"applied_definition_refinements: {result.applied_definition_refinements}")
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
