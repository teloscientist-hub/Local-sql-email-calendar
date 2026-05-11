# Prompt refinement — the self-evolving routing prompt

> The routing classifier learns from every correction the owner makes. After enough corrections accumulate, Claude Sonnet reads the current prompt + the recent corrections and proposes minimal edits — new anchors or definition refinements — that get auto-deployed.

This is **Phase 5.5.5** of the system. The pattern is general (any prompt that needs to self-evolve from user feedback), but the working implementation only targets the routing classifier. Cluster + rating classifiers don't have it yet.

---

## The loop

```
       new email arrives
              │
              ▼
    routing-worker classifies
              │
              ▼
       /route-suggest cached
              │
              ▼
   owner presses Cmd+Option+<letter>
              │
   ┌──────────┼──────────┐
   │          │          │
  accept   override    manual
   │          │          │
   └──────────┴──────────┘
              │
              ▼
   routing_corrections row inserted
              │
              ▼
   counter += 1
              │
        ┌─────┴─────┐
        │           │
   counter <       counter ≥
   threshold        threshold
        │           │
        │           ▼
        │    prompt_refinement.refine()
        │           │
        │           ▼
        │   Sonnet reads current prompt + last 200 corrections
        │           │
        │           ▼
        │   proposes new_anchors + definition_refinements
        │           │
        │           ▼
        │   apply step validates + writes v{N+1}
        │           │
        │           ▼
        │   prompts/CURRENT_VERSION.txt atomically updated
        │           │
        │           ▼
        │   routing_prompt_versions audit row inserted
        │           │
        │           ▼
        │   counter resets to 0
        │
        ▼
   continue routing
```

---

## Trigger condition

The trigger lives in the running sidecar process (`server.py`). Two parameters:

- **`MML_CLASSIFIER_ROUTING_REFINEMENT_TRIGGER_COUNT`** (default 25) — how many net-new `routing_corrections` rows must accumulate since the last refinement before the next one fires.
- **`MML_CLASSIFIER_ROUTING_REFINEMENT_CORRECTIONS_WINDOW`** (default 200) — how many recent rows to inject into the meta-prompt.

The counter is in-memory; restarting the sidecar resets it. This is fine — the worst case is one extra refinement after a restart, which is cheap.

---

## What the meta-LLM is allowed to change

`prompts/refinement_meta_v1.md` constrains the LLM to ONLY two kinds of edit:

### A. New anchors

A single-line addition to the `# Known signals` section of the routing prompt. Format:

```
- `Routed/<folder>` — <sender-or-domain>, <optional subject pattern>
```

The LLM must back each new anchor with ≥2 corrections in the corpus and cite them in the `evidence` field of its JSON response.

### B. Definition refinements

A byte-for-byte phrase replacement within a `## \`Routed/<folder>\` — <Title>` definition section. The replacement must:

- Match a phrase byte-for-byte in the current prompt (the apply step refuses if not found).
- Stay within the definition prose of that one folder section — no touching other folders, the "Distinguish from" callouts, decision rules, or output format.
- Be backed by ≥3 corrections.

### What the LLM is NOT allowed to change

The applier rejects edits that:
- Touch the folder name set (the folders are configured in `services/.../config.py ROUTING_FOLDERS`; changing them would desync the keymap).
- Touch the `# Decision rules` section.
- Touch the `# Output format` section.
- Change the order or count of folder definition sections.
- Edit inside code fences ``` ... ```.

These constraints keep refinements safe enough to auto-deploy without human review.

---

## The audit table

`migrations/07_prompt_versions.sql` creates `routing_prompt_versions`:

```sql
CREATE TABLE IF NOT EXISTS routing_prompt_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    version         TEXT NOT NULL UNIQUE,    -- e.g. 'route_suggest_v6'
    parent_version  TEXT,                    -- previous version this evolved from
    deployed_at     TEXT NOT NULL,           -- ISO8601 UTC
    refinement_payload TEXT,                 -- the LLM's full JSON response
    corrections_window_size INTEGER,         -- N corrections analyzed
    new_anchors_count INTEGER,
    definition_refinements_count INTEGER,
    overall_confidence REAL,
    deploy_kind     TEXT CHECK(deploy_kind IN ('auto', 'manual', 'rollback'))
);
```

Every refinement run inserts a row. Even dry-runs that produced no edits are logged (with `new_anchors_count=0` and `definition_refinements_count=0`).

Query the history:

```sql
SELECT version, parent_version, deployed_at,
       new_anchors_count, definition_refinements_count,
       overall_confidence, deploy_kind
FROM routing_prompt_versions
ORDER BY deployed_at DESC LIMIT 20;
```

---

## Rollback

The current live prompt is whatever `prompts/CURRENT_VERSION.txt` says:

```sh
cat services/mml-classifier/mml_classifier/prompts/CURRENT_VERSION.txt
# route_suggest_v7
```

To roll back to the parent version:

```sh
cd services/mml-classifier
.venv/bin/python -m mml_classifier.prompt_refinement --rollback
```

This reads `routing_prompt_versions.parent_version` for the current version, writes it to `CURRENT_VERSION.txt`, and inserts a new audit row with `deploy_kind='rollback'`.

To roll back to an arbitrary earlier version (manual override):

```sh
echo "route_suggest_v4" > services/mml-classifier/mml_classifier/prompts/CURRENT_VERSION.txt
# The next /route-suggest call reads the new pointer.
```

The version-tagging on `routing_suggestions` means rolling back doesn't destroy any prior classifications — they stay queryable by their `classifier_version`, and the new (rolled-back) version simply produces fresh rows alongside the old ones.

---

## Cost shape

- **Per refinement run** (Sonnet, ~25k-token prompt + ~9k-token corrections corpus): typically ~$0.10–$0.20 with warm-cache pricing.
- **At a typical correction rate of ~5/day**, refinements fire every ~5 days. Annual cost: ~$10–$15.
- The timeout (`MML_CLASSIFIER_ROUTING_REFINEMENT_TIMEOUT`, default 300s) is generous because cold ephemeral cache + long input can push a Sonnet call to 90–250s.

---

## Manual operations

```sh
# Force a refinement now (counter ignored)
.venv/bin/python -m mml_classifier.prompt_refinement

# Dry-run: print the proposed v{N+1} and a diff, write nothing
.venv/bin/python -m mml_classifier.prompt_refinement --dry-run

# Roll back to parent version
.venv/bin/python -m mml_classifier.prompt_refinement --rollback

# Roll back to a specific named version
echo "route_suggest_v4" > services/mml-classifier/mml_classifier/prompts/CURRENT_VERSION.txt
```

---

## Extending the pattern to other classifiers

The same shape works for any classifier with a structured prompt + a corrections corpus. To add it to the rating or cluster classifiers:

1. Author a `<classifier>_refinement_meta_v1.md` analogous to `refinement_meta_v1.md`, with edit constraints appropriate to that prompt's shape.
2. Reuse the `prompt_refinement.refine()` machinery — it's parameterized by which prompt to read, which corpus SQL to run, which version file to point at, and which audit table to write to.
3. Add a trigger to the sidecar (`server.py`) that counts the relevant corrections and fires periodically.
4. Add an analogous audit table (`<classifier>_prompt_versions`) via a new migration.

The cluster classifier in particular would benefit — clusters drift as life changes, and the corrections corpus (cluster_id from the LLM vs cluster_id the owner picked via a manual reclassification keystroke) carries the same signal shape as routing.

---

## Why this design

The alternative — handwritten prompt edits — has two failure modes the auto loop avoids:

1. **The user never gets around to editing the prompt.** Manual edits require noticing the drift, deciding what to change, and writing it. The auto loop just *runs*.
2. **Edits get sloppy over time.** Corrections-aware refinements are minimal and evidence-cited. Hand-edits tend to overshoot or rewrite working sections.

The constraint set (only anchors + definition refinements; no schema changes) is what makes auto-deploy safe. The applier rejects ~10% of LLM proposals on the byte-for-byte phrase check — that's the right cost.

The pattern generalizes: any prompt that needs to self-evolve, plus a structured corrections corpus, plus a small set of allowed edit kinds, plus a version-tagging cache-invalidation primitive, equals a stable self-improvement loop.
