"""Unit tests for the effective-rating algorithm.

Pure-function tests — no warehouse, no CSV. We monkeypatch the manual_ratings()
cache so we don't depend on the real contacts_to_rate.csv.
"""

from __future__ import annotations

import pytest

from mml_classifier import ratings


@pytest.fixture(autouse=True)
def _stub_manual_ratings(monkeypatch):
    fixed = {
        "melinda@vintagejewelrycollect.com": 9,
        "leigh@example.com": 7,
    }
    monkeypatch.setattr(ratings, "manual_ratings", lambda: fixed)
    yield


def test_manual_rating_overrides_everything():
    # Cluster 30 (transactional) defaults to 0; manual rating wins.
    assert ratings.effective_rating_for(
        sender_addr="melinda@vintagejewelrycollect.com",
        cluster_id=30,
        priority_friend=False,
    ) == 9


def test_priority_friend_floor_when_no_manual():
    # No manual rating; cluster default is 5 (cluster 6); priority_friend → floor 8.
    assert ratings.effective_rating_for(
        sender_addr="someone-not-rated@example.com",
        cluster_id=6,
        priority_friend=True,
    ) == 8


def test_family_cluster_overrides_priority_friend():
    # cluster 3 (Family) → 9, even with priority_friend off.
    assert ratings.effective_rating_for(
        sender_addr="cousin@example.com",
        cluster_id=3,
        priority_friend=False,
    ) == 9


def test_cluster_default_when_no_manual_and_no_priority_friend():
    # Cluster 29 (Newsletters) defaults to 1.
    assert ratings.effective_rating_for(
        sender_addr="newsletter@example.com",
        cluster_id=29,
        priority_friend=False,
    ) == 1


def test_zero_for_unrated_unclassified():
    assert ratings.effective_rating_for(
        sender_addr=None,
        cluster_id=None,
        priority_friend=False,
    ) == 0


def test_transactional_default_zero():
    # Cluster 30 → 0. The badge layer treats this as "no person tier".
    assert ratings.effective_rating_for(
        sender_addr="alerts@example.com",
        cluster_id=30,
        priority_friend=False,
    ) == 0


def test_case_insensitive_manual_lookup():
    # Manual ratings are stored lowercase; sender_addr should be case-folded.
    assert ratings.effective_rating_for(
        sender_addr="MELINDA@VintageJewelryCollect.com",
        cluster_id=30,
        priority_friend=False,
    ) == 9
