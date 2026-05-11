"""Single source of truth for paths, ports, versions, thresholds.

Everything that another module might want to tweak lives here.
Override any value via environment variable: MML_CLASSIFIER_<NAME>.
"""

from __future__ import annotations

import os
from pathlib import Path

# ---- Paths ------------------------------------------------------------------

# Data root: parents[3] from this file resolves to the repo root, which is
# where warehouse.sqlite / contacts_to_rate.csv / gcal_*.json live by default.
# Override any of the derived paths via MML_CLASSIFIER_<NAME> env vars below.
DATA_ROOT = Path(__file__).resolve().parents[3]

WAREHOUSE_DB = Path(
    os.environ.get(
        "MML_CLASSIFIER_WAREHOUSE_DB",
        DATA_ROOT / "warehouse.sqlite",
    )
)
CONTACTS_CSV = Path(
    os.environ.get(
        "MML_CLASSIFIER_CONTACTS_CSV",
        DATA_ROOT / "contacts_to_rate.csv",
    )
)
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"

# ---- HTTP server ------------------------------------------------------------

HOST = os.environ.get("MML_CLASSIFIER_HOST", "127.0.0.1")
PORT = int(os.environ.get("MML_CLASSIFIER_PORT", "8765"))

# ---- Claude CLI -------------------------------------------------------------

CLAUDE_CLI = os.environ.get("MML_CLASSIFIER_CLAUDE_CLI", "claude")
CLAUDE_MODEL = os.environ.get("MML_CLASSIFIER_CLAUDE_MODEL", "haiku")
CLAUDE_TIMEOUT_SECONDS = int(os.environ.get("MML_CLASSIFIER_CLAUDE_TIMEOUT", "120"))
CLAUDE_MAX_RETRIES = int(os.environ.get("MML_CLASSIFIER_CLAUDE_MAX_RETRIES", "3"))

# ---- Scoring ----------------------------------------------------------------

# Fall-through clusters that warrant LLM body-read.
# 29 = Newsletters / lists, 30 = Transactional / automated, 31 = Cold inbound.
FALL_THROUGH_CLUSTER_IDS: frozenset[int] = frozenset({29, 30, 31})

# Threshold above which the plugin should show the TLDR overlay.
TLDR_THRESHOLD = float(os.environ.get("MML_CLASSIFIER_TLDR_THRESHOLD", "0.6"))

# Body truncation — keeps prompts cheap and avoids CLI arg/stdin limits.
BODY_MAX_CHARS = int(os.environ.get("MML_CLASSIFIER_BODY_MAX_CHARS", "8000"))

# ---- Google Calendar (Phase 5) ---------------------------------------------

# OAuth2 credentials for the single-account MVP. The user creates a Desktop-app
# OAuth client in Google Cloud Console, downloads client_secret.json, and saves
# it at GCAL_CLIENT_SECRETS_PATH. The one-time `python -m
# mml_classifier.gcal_oauth_setup` flow consents and writes the refresh token
# to GCAL_TOKEN_PATH; the sidecar refreshes it silently thereafter.
GCAL_CLIENT_SECRETS_PATH = Path(
    os.environ.get(
        "MML_CLASSIFIER_GCAL_CLIENT_SECRETS_PATH",
        DATA_ROOT / "gcal_client_secrets.json",
    )
)
GCAL_TOKEN_PATH = Path(
    os.environ.get(
        "MML_CLASSIFIER_GCAL_TOKEN_PATH",
        DATA_ROOT / "gcal_token.json",
    )
)
GCAL_GOOGLE_ACCOUNT = os.environ.get(
    "MML_CLASSIFIER_GCAL_GOOGLE_ACCOUNT", ""
)
GCAL_TIMEZONE = os.environ.get(
    "MML_CLASSIFIER_GCAL_TIMEZONE", "America/Los_Angeles"
)
# Scopes are intentionally minimal — events.insert + readonly on the calendar
# list (for seeding `calendars` rows).
GCAL_SCOPES = (
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
)

# Prompt versioning for the draft-event LLM call.
EVENT_DRAFTER_PROMPT_VERSION = "draft_event_v1"
EVENT_DRAFTER_VERSION = f"{EVENT_DRAFTER_PROMPT_VERSION}@{CLAUDE_MODEL}"

# ---- Routing classifier (Phase 5.5.2) --------------------------------------

# Folders the routing classifier may suggest. The literal string 'none' is
# also valid and means "no Routed/ folder is appropriate." Stored verbatim
# in routing_suggestions.suggested_folder so we can grow this set later
# without a schema change.
#
# Names below are GENERIC PLACEHOLDERS (Routed/A..H). Rename to your own
# folder names and keep four files in sync:
#   - this tuple
#   - plugin/keymaps/mml-routed.json (key bindings)
#   - plugin/src/routed-keystroke-handler.js ROUTES dict
#   - prompts/route_suggest_v*.md (the LLM must see the same folder names
#     it's allowed to suggest)
ROUTING_FOLDERS: tuple[str, ...] = (
    "Routed/A",
    "Routed/B",
    "Routed/C",
    "Routed/E",
    "Routed/F",
    "Routed/M",
    "Routed/P",
    "Routed/S",
)

# Source of truth for the live prompt version is now a file written by the
# self-refinement loop. `prompts/CURRENT_VERSION.txt` contains a single line
# like `route_suggest_v4` (or v5, v6, …). Atomically rewritten on each
# refinement. Rollback = hand-write a different name to this file.
_CURRENT_VERSION_FILE = PROMPTS_DIR / "CURRENT_VERSION.txt"
_PROMPT_VERSION_FALLBACK = "route_suggest_v4"


def _read_current_prompt_version() -> str:
    try:
        v = _CURRENT_VERSION_FILE.read_text(encoding="utf-8").strip()
        return v or _PROMPT_VERSION_FALLBACK
    except FileNotFoundError:
        return _PROMPT_VERSION_FALLBACK


ROUTING_PROMPT_VERSION = _read_current_prompt_version()
ROUTING_CLASSIFIER_VERSION = f"{ROUTING_PROMPT_VERSION}@{CLAUDE_MODEL}"

# Phase 5.5.5 — self-refining prompt.
# Trigger the refinement after this many net-new routing_corrections rows
# have accumulated since the last refinement. Counter lives in the running
# sidecar (resets on process restart) — see server.py.
ROUTING_REFINEMENT_TRIGGER_COUNT = int(os.environ.get(
    "MML_CLASSIFIER_ROUTING_REFINEMENT_TRIGGER_COUNT", "25"
))
# Meta-model: refinement analyses a larger context (full prompt + 200
# corrections) and articulates structured edits — Haiku may miss subtleties,
# so we default to Sonnet. `claude --model sonnet` resolves the alias.
ROUTING_REFINEMENT_MODEL = os.environ.get(
    "MML_CLASSIFIER_ROUTING_REFINEMENT_MODEL", "sonnet"
)
ROUTING_REFINEMENT_PROMPT_VERSION = "refinement_meta_v1"
ROUTING_REFINEMENT_CORRECTIONS_WINDOW = int(os.environ.get(
    "MML_CLASSIFIER_ROUTING_REFINEMENT_CORRECTIONS_WINDOW", "200"
))
# Per-call timeout for the refinement Claude call. Sonnet through the claude
# CLI on a cold ephemeral cache can take 90–250s for a ~25k-token input.
# 300s absorbs the cold case; retries are still available if it overruns.
ROUTING_REFINEMENT_TIMEOUT_SECONDS = int(os.environ.get(
    "MML_CLASSIFIER_ROUTING_REFINEMENT_TIMEOUT", "300"
))

# Body truncation for the routing classifier's user-prompt. Smaller than
# content_scorer's BODY_MAX_CHARS — classification cares about gist, not
# the full body.
ROUTING_BODY_MAX_CHARS = int(os.environ.get("MML_CLASSIFIER_ROUTING_BODY_MAX_CHARS", "2000"))

# How many recent routing_corrections rows to inject into the system prompt
# as ground-truth examples. Zero disables. 50 is a good sweet spot: enough
# signal to influence behavior, low enough that the prompt stays compact.
ROUTING_CORRECTIONS_FEW_SHOT_LIMIT = int(
    os.environ.get("MML_CLASSIFIER_ROUTING_CORRECTIONS_FEW_SHOT_LIMIT", "50")
)

# Re-run classification only if no cached suggestion exists for the current
# ROUTING_CLASSIFIER_VERSION on a message. Bumping the version (prompt edit
# or model change) implicitly invalidates the cache.

# ---- Rating classifier (Phase 6.0 — 0-9 rating suggester) ------------------

# Source-of-truth for the 0-9 scale lives at `docs/RATING_SCALE.md`. The
# prompt embeds the scale verbatim (it's short); cluster defaults live in
# ratings.py CLUSTER_DEFAULT_RATING. Both feed prompts/rating_suggest_v1.md.
RATING_PROMPT_VERSION = "rating_suggest_v1"
RATING_CLASSIFIER_MODEL = os.environ.get(
    "MML_CLASSIFIER_RATING_MODEL", CLAUDE_MODEL,
)
RATING_CLASSIFIER_VERSION = f"{RATING_PROMPT_VERSION}@{RATING_CLASSIFIER_MODEL}"
RATING_BODY_MAX_CHARS = int(os.environ.get(
    "MML_CLASSIFIER_RATING_BODY_MAX_CHARS", "2000"
))
RATING_CLASSIFIER_TIMEOUT_SECONDS = int(os.environ.get(
    "MML_CLASSIFIER_RATING_TIMEOUT", "60"
))
# How many recent message_ratings rows to inject as ground-truth few-shot
# in the rating prompt. Same role corrections play for the routing
# classifier. 50 is a reasonable balance.
RATING_CORRECTIONS_FEW_SHOT_LIMIT = int(os.environ.get(
    "MML_CLASSIFIER_RATING_CORRECTIONS_FEW_SHOT_LIMIT", "50"
))

# ---- Cluster classifier (Phase 4.5 — real-time) -----------------------------

# Single source of truth for the cluster taxonomy lives at
# `<DATA_ROOT>/email_classification_instructions_universal.md`, produced by
# running `python -m tools.taxonomy_generator`. The local wrapper
# `prompts/cluster_classify_v1.md` references it; runtime concatenates the
# two for the system prompt.
CLUSTER_PROMPT_VERSION = "cluster_classify_v1"
CLUSTER_CLASSIFIER_MODEL = os.environ.get(
    "MML_CLASSIFIER_CLUSTER_MODEL", CLAUDE_MODEL,
)
CLUSTER_CLASSIFIER_VERSION = f"{CLUSTER_PROMPT_VERSION}@{CLUSTER_CLASSIFIER_MODEL}"
CLUSTER_BODY_MAX_CHARS = int(os.environ.get(
    "MML_CLASSIFIER_CLUSTER_BODY_MAX_CHARS", "5000"
))
CLUSTER_CLASSIFIER_TIMEOUT_SECONDS = int(os.environ.get(
    "MML_CLASSIFIER_CLUSTER_TIMEOUT", "120"
))

# ---- Provenance -------------------------------------------------------------

INGESTER_VERSION = "mml-classifier@0.1.0"
SCORER_PROMPT_VERSION = "content_score_v1"
SCORER_VERSION = f"{SCORER_PROMPT_VERSION}@{CLAUDE_MODEL}"
