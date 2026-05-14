"""Unit tests for rating_prompt_refinement (Phase 6.0.g).

These tests cover the pure / SQL-less paths: sanitization, version bumping,
anchor application (create-section + append-existing), and validation
guards. The meta-LLM call and DB writes are not exercised here — see the
end-to-end smoke test in CLI form for those.
"""

from __future__ import annotations

import pytest

from mml_classifier import rating_prompt_refinement as rpr


# ---- _sanitize_sender ------------------------------------------------------

def test_sanitize_sender_strips_backticks_quotes_whitespace():
    assert rpr._sanitize_sender("  `sarah@x.com`  ") == "sarah@x.com"
    assert rpr._sanitize_sender('"sarah@x.com"') == "sarah@x.com"
    assert rpr._sanitize_sender("'@substack.com'") == "@substack.com"
    assert rpr._sanitize_sender("") == ""
    assert rpr._sanitize_sender(None) == ""


# ---- _next_version_name ----------------------------------------------------

def test_next_version_name_bumps_numeric_suffix():
    assert rpr._next_version_name("rating_suggest_v1") == "rating_suggest_v2"
    assert rpr._next_version_name("rating_suggest_v9") == "rating_suggest_v10"
    assert rpr._next_version_name("rating_suggest_v42") == "rating_suggest_v43"


def test_next_version_name_falls_back_when_pattern_doesnt_match():
    assert rpr._next_version_name("weird_name") == "weird_name_r1"


# ---- _apply_anchors --------------------------------------------------------

_BASE_PROMPT = (
    "# The 0–9 scale\n\nstuff\n\n"
    "# Inputs you'll receive\n\nstuff\n\n"
    "# How to think about it\n\nstuff `priority_friend` flag stuff "
    "Family (cluster 3) stuff\n\n"
    "# Output\n\n```json\n"
    '{"suggested_rating":0,"confidence":0.0,"reason":""}\n'
    "```\n"
)


def test_apply_anchors_creates_section_when_missing():
    dropped: list[str] = []
    new_prompt, applied = rpr._apply_anchors(
        _BASE_PROMPT,
        [{"sender": "sarah@x.com", "rating": 7, "note": "responsive coach"}],
        dropped,
    )
    assert applied == 1
    assert "# Known sender ratings (auto-curated)" in new_prompt
    assert "`sarah@x.com`" in new_prompt
    assert "rating 7" in new_prompt
    assert "responsive coach" in new_prompt
    assert dropped == []


def test_apply_anchors_appends_inside_existing_section():
    prompt_with_section = (
        _BASE_PROMPT
        + "\n# Known sender ratings (auto-curated)\n\n"
        + "- `existing@x.com` — rating 3, prior anchor *(added by refinement on 2026-05-01)*\n"
    )
    dropped: list[str] = []
    new_prompt, applied = rpr._apply_anchors(
        prompt_with_section,
        [{"sender": "new@y.com", "rating": 5, "note": "added"}],
        dropped,
    )
    assert applied == 1
    assert "`existing@x.com`" in new_prompt  # prior anchor preserved
    assert "`new@y.com`" in new_prompt       # new one appended
    # And no duplicate header was inserted.
    assert new_prompt.count("# Known sender ratings (auto-curated)") == 1


def test_apply_anchors_drops_duplicates_in_existing_section():
    prompt_with_section = (
        _BASE_PROMPT
        + "\n# Known sender ratings (auto-curated)\n\n"
        + "- `dup@x.com` — rating 3, prior anchor *(added by refinement on 2026-05-01)*\n"
    )
    dropped: list[str] = []
    new_prompt, applied = rpr._apply_anchors(
        prompt_with_section,
        [{"sender": "dup@x.com", "rating": 4, "note": "second attempt"}],
        dropped,
    )
    assert applied == 0
    assert any("already anchored" in d for d in dropped)


def test_apply_anchors_drops_invalid_rating():
    dropped: list[str] = []
    _, applied = rpr._apply_anchors(
        _BASE_PROMPT,
        [{"sender": "bad@x.com", "rating": 11, "note": ""}],
        dropped,
    )
    assert applied == 0
    assert any("invalid rating" in d for d in dropped)


def test_apply_anchors_drops_empty_sender():
    dropped: list[str] = []
    _, applied = rpr._apply_anchors(
        _BASE_PROMPT,
        [{"sender": "", "rating": 5, "note": ""}],
        dropped,
    )
    assert applied == 0
    assert any("empty sender" in d for d in dropped)


def test_apply_anchors_handles_missing_note_gracefully():
    dropped: list[str] = []
    new_prompt, applied = rpr._apply_anchors(
        _BASE_PROMPT,
        [{"sender": "nonotes@x.com", "rating": 6}],
        dropped,
    )
    assert applied == 1
    assert "`nonotes@x.com`" in new_prompt
    assert "rating 6" in new_prompt


# ---- _validate_candidate ---------------------------------------------------

def test_validate_accepts_healthy_prompt():
    assert rpr._validate_candidate(_BASE_PROMPT) is None


def test_validate_rejects_missing_header():
    bad = _BASE_PROMPT.replace("# The 0–9 scale", "# The scale")
    reason = rpr._validate_candidate(bad)
    assert reason is not None
    assert "# The 0–9 scale" in reason


def test_validate_rejects_missing_output_schema():
    bad = _BASE_PROMPT.replace('"suggested_rating"', '"rating"')
    reason = rpr._validate_candidate(bad)
    assert reason is not None
    assert "suggested_rating" in reason


def test_validate_rejects_missing_override_priority_rule():
    bad = _BASE_PROMPT.replace("Family (cluster 3)", "Family")
    reason = rpr._validate_candidate(bad)
    assert reason is not None
    assert "Family (cluster 3)" in reason


# ---- Schema-shape sanity ---------------------------------------------------

def test_refinement_schema_requires_new_anchors_only():
    """v1 design: only new_anchors is required. Other top-level keys are optional."""
    schema = rpr.REFINEMENT_SCHEMA
    assert "new_anchors" in schema["required"]
    # If we ever add other required keys we want to know — this test will catch.
    assert schema["required"] == ["new_anchors"]
