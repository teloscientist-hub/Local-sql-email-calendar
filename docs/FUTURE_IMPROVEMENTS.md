# Future improvements

A queryable backlog of deferred system-improvement ideas. Items here are deliberate parking — not "todo soon" but "worth doing eventually, capture so we don't lose the design thinking."

When you're using the system and you spot something worth doing-later, drop it here with enough context to act on cold. Each item should be self-contained: title, one-paragraph description, and a hint about where the design conversation lived (your AI session, a plan file, etc.).

The items below are the ones the original system parked. They're useful both as concrete next steps and as examples of the shape a Future Improvements entry should take.

---

## Explicit tag-to-rule translation process

Right now the `Ctrl+Cmd+0..9` tag loop is **mechanical and implicit**: tags land in `message_ratings`, the per-contact rating in `contacts_to_rate.csv` updates per-message-immediate when no note is attached, and that's it. What's missing is the **conductor**: cadence, thresholds, governance, trust-building, and rollback for the *automation* of those tags into rules that reshape future classifications.

### v1 sketch — locked

- **Trigger:** manual CLI command — `mml-classifier review-notes --since-last-N=25`. You run it when ~25 new notes have accumulated.
- **Rule shape:** `(sender_predicate, content_predicate) → rating_override`. Both predicates are **deterministic** at evaluation time (sender regex / cluster-ID match / body regex / contact-rating range — *not* LLM-evaluated). LLM is used only to *derive* proposed rules from the notes corpus; rule evaluation at runtime stays fast and zero-token.
- **Storage:** new `rating_rules` table. Minimal columns: `sender_predicate TEXT`, `content_predicate TEXT`, `rating_override INTEGER`, `created_at TEXT`, `retired_at TEXT` (NULL = active; non-NULL = soft-deleted, evaluator skips). Append-only.
- **Workflow:** sidecar gathers the 25-note window, hands the rows (with `system_rating_at_time`, `system_cluster_at_time`, sender info, body excerpt, and the note text) to the LLM. It proposes 3–5 conditional rules. You review each — accept, edit, or reject. Accepted rules land in `rating_rules`.
- **Fallback-chain placement:** rules slot above per-contact baseline, below per-message manual override:
  1. `message_ratings.rating` (latest manual override).
  2. **Matching `rating_rules`** (most-specific wins; ties broken by `created_at DESC`).
  3. `contacts_to_rate.csv` (per-contact baseline).
  4. `zero_value_senders` → 0.
  5. Cluster default per `RATING_SCALE.md`.
  6. 0.
- **Governance:** you are in the seat for every rule. No auto-apply, no batching. Trust-building first; cadence, thresholds, and auto-apply for low-risk patterns come later once the v1 loop has been used enough to know what "low-risk" looks like.
- **Rollback:** mark a rule's `retired_at` and the evaluator skips it. No SQL DELETE.

## Cluster-default rebase

When your manual `Ctrl+Cmd+0..9` tags consistently diverge from a cluster's default rating, propose a rebase of the cluster→rating mapping in `RATING_SCALE.md`. The signal lives in `message_ratings.system_cluster_at_time` (captured at tag time).

**Implementation:** periodic batch job that aggregates by cluster, computes the median tag vs the current default, and surfaces clusters where divergence exceeds a threshold (e.g., median diverges by ≥2 across ≥10 tagged messages). Output is a proposal you review; no automatic mutation.

## Reclassification proposals

When manual tags imply a message is in the wrong cluster (e.g., consistently rated 3 but classified as cluster 1 "Friends" with default 7), surface it as a candidate for reassignment. Hardest of the active-learning loops; requires either LLM-in-the-loop reasoning ("does this message really look like cluster 1?") or rule-mining over `message_ratings` joined with `message_classifications`. Defer until cluster-default rebase has been operating long enough to produce a corpus to learn from.

## Divergence audit as a feature

Promote the spot-check SQL into a small sidecar report or endpoint: "clusters where my tags diverge from defaults by ≥X." Visible on demand — e.g., `GET /audit/divergence?threshold=2` on the sidecar, or a small CLI. Closes the loop between tagging discipline and rule refinement: you can see whether your corrections are consistent enough to trust before any rebase proposal fires.

## Zero-value-sender promotion

When ≥3 messages from the same sender all get tagged 0 (explicit zero-value), promote the sender to the `zero_value_senders` table. The system would then treat them as zero-value across all messages, not just the tagged ones. Open question: auto-apply, or surface as a proposal? Default lean: proposal — zero-value is a strong claim that's annoying to retract.

## Mailspring `moveCopyToFolder` action — file but leave in Inbox

Mailspring's native rule engine has no equivalent of Outlook's `moveCopyToFolderAction` (file the message into a folder while leaving the original in the Inbox). Useful for any rule that wants "I want to find this in folder X later AND have it visible in Inbox now" — e.g., shipping notifications that you want filed but also want to see today.

**Cheapest implementation:** add a `moveCopyToFolder` template to the existing plugin. Mailspring's `Template` system in `mail-rules-templates.js` is extensible via plugin contributions; the action handler would clone the message before firing `ChangeFolderTask` (or `ChangeLabelsTask` for Gmail). Estimated ~30 LOC + a registration line in the plugin's `package.json` activation.

**Alternative shortcuts** that need no plugin work: star action (keeps in Inbox visually pinned) or apply-label (Gmail only — labels are pure metadata and don't move).

## Continuous live ingest

Replace the manual `mailspring_intake --commit` CLI with a 5-minute polling daemon. Trigger via launchd `StartInterval=300`. Same logic as the one-shot, just running on a timer. Needs:
- A `last_ingest_at` watermark table or simple `MAX(received_date)` query.
- Concurrency lock so two timers don't collide.
- A way to disable when you're traveling on flaky wifi (env var? touch a sentinel file?).

## Smart entity dedup

The initial pipeline creates a fresh `contact_entity` for every unknown address, even when the same human appears under multiple addresses with similar names. After a few months of mail you'll have duplicate entities for `joe@personal.com` and `joe.smith@workplace.com` even though they're the same person.

Build a merge tool that:
1. Surfaces candidate duplicates (name-similarity + at-least-one-shared-thread heuristic).
2. Shows you both entities + sample mail from each.
3. On approval, merges `contact_email_map.contact_entity_id` from one into the other and tombstones the redundant `contact_entities` row.

## Tailscale exposure

Currently localhost-only. To triage from your phone or laptop while away from the source-of-truth Mac, expose the sidecar via Tailscale and authenticate using Tailscale's identity headers. The sidecar's permissive 200-on-everything behavior makes this safe-ish — but add an explicit allowlist of Tailscale node-IDs as a config option before exposing anything.

## Litestream backup

Continuous SQLite backup to S3-compatible storage (Backblaze B2 is the cheap option). The warehouse is the single load-bearing artifact; a crash that corrupts it would erase your ratings and classifications. Litestream replicates the WAL stream out-of-band, low overhead.

## Graph projection — Neo4j + Graphiti

Project the silver layer (warehouse) into a graph DB for relationship queries that don't fit in SQL. Examples: "who's two hops from a priority friend", "who introduced me to whom", "find people I haven't emailed in 6 months who I used to email weekly". The graph projection is **deferred** — current SQL queries handle 95% of triage needs. Revisit once you have specific queries that SQL is the wrong shape for.

---

## Adding new entries

When you spot something worth deferring, add it here with:

1. **Short title** (H2).
2. **One paragraph** describing the problem + the proposed shape.
3. **Implementation sketch** if you have one — even rough is useful.
4. **Originating context** if it came from a specific debugging session or AI conversation, so you can pick up the thread.

Don't worry about ordering. The doc is a list, not a priority queue. Re-read it periodically; some items will become "do now" and migrate out, others will reveal themselves as never-going-to-happen and can be deleted.
