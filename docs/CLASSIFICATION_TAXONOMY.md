# Classification taxonomy — the per-deployment workflow

> The system classifies every email thread into a cluster reflecting the relationship + intent of the thread. Each cluster maps to a default rating in [`RATING_SCALE.md`](RATING_SCALE.md). Rather than ship a fixed cluster set that fits nobody, this template ships a **taxonomy generator** that proposes a taxonomy from YOUR own mail history. You review, edit, save.

The cluster taxonomy lives at `email_classification_instructions_universal.md` at the repo root. It's the document the cluster classifier loads as its system prompt at runtime. It's also the document you keep editing as your life changes.

---

## The workflow

### 1. Run the generator

```sh
python -m tools.taxonomy_generator --propose --sample 500 --years 5
```

What happens:
1. The generator reads `warehouse.sqlite` (which you populated via Phase 1 of [`SETUP.md`](../SETUP.md) — PST / mbox / IMAP ingest).
2. It selects a stratified random sample of ~500 messages spanning the last 5 years (you can adjust both with the flags). Stratification covers sender and folder so the sample isn't dominated by a single high-volume mailing list.
3. It builds a context payload (sender + subject + body excerpt for each sampled message) and calls Claude Sonnet with `prompts/taxonomy_meta_v1.md`.
4. The LLM proposes a taxonomy of 20–40 clusters reflecting the patterns it sees, with names, definitions, example signal phrases, and a `default_rating` for each cluster.
5. The proposal is written to `email_classification_instructions_universal.draft.md` at the repo root.

Time: ~2–5 minutes. Cost: a few cents on Sonnet.

### 2. Review the draft

Open `email_classification_instructions_universal.draft.md` in your editor. You're looking for:

- **Cluster names**: do they sound like things you'd recognize? Are they about *relationships*, not *content* ("Newsletters / lists", not "Articles about AI")?
- **Cluster count**: 20–40 is the target range. Below 20 = too coarse; above 40 = too granular.
- **Coverage**: do the clusters span the visible patterns in your inbox? Friends, family, vendors, newsletters, transactional, cold pitches, your actual businesses?
- **Auto-rules**: the draft should propose a short "Pre-classification auto-rules" section. Verify the rules look right.
- **Disambiguation**: the draft should have a "Disambiguation rules" section calling out ambiguous pairs. Verify they match your judgment.
- **`Needs Review` cluster**: there should be a reserved cluster for low-confidence cases. Keep it.

Common adjustments:
- **Rename ambiguous clusters.** If two clusters could overlap, rename one to be more specific.
- **Merge tiny clusters.** If a cluster has only 1–2 examples in the sample, merge it into a neighbor or delete it.
- **Split overloaded clusters.** If a cluster description tries to cover too much, split it.
- **Adjust default ratings.** The 0–9 scale's meaning is in [`RATING_SCALE.md`](RATING_SCALE.md).

### 3. Save

```sh
mv email_classification_instructions_universal.draft.md \
   email_classification_instructions_universal.md
```

The non-`.draft` filename is what `cluster_classifier.py` looks for at runtime (per `services/mml-classifier/mml_classifier/cluster_classifier.py:_load_system_prompt()`).

### 4. Populate `cluster_definitions` from the doc

The doc is the source of truth for the LLM; `cluster_definitions` is the source of truth for the warehouse. Sync them:

```sql
INSERT INTO cluster_definitions (cluster_id, cluster_name, main_category,
                                 created_at, definition_version)
VALUES
  (1, 'Longtime friends', 'personal', datetime('now'), 'v1'),
  (2, 'Family',           'personal', datetime('now'), 'v1'),
  -- ... one row per cluster in your doc
  ;
```

### 5. Set default ratings

Each cluster's default rating maps to `services/mml-classifier/mml_classifier/ratings.py` `CLUSTER_DEFAULT_RATING`:

```python
CLUSTER_DEFAULT_RATING: dict[int, int] = {
    1: 7,   # Longtime friends
    2: 9,   # Family
    # ... matching the default_rating field in your generated doc
}
```

Restart the sidecar after editing (`launchctl kickstart -k gui/$(id -u)/com.mml.classifier`).

### 6. Backfill

Run the cluster classifier across your historical messages:

```sh
cd services/mml-classifier
.venv/bin/python -m mml_classifier.cluster_classifier --backfill --limit 1000
```

The classifier reads `message_classifications` filtered on the current `classifier_version` (`cluster_classify_v1@haiku` by default) and skips anything already classified at that version. Re-runs are idempotent.

After the backfill, every message has a cluster assignment, and the rating + plugin badge can use it.

---

## When to re-run

Re-run the generator any time:
- **Your life changes substantively.** New job / business / partner / project / hobby / volunteer commitment.
- **The `Needs Review` bucket grows.** If the classifier can't confidently bucket more than ~10% of new mail, you have a structural gap.
- **You notice systematic mis-classifications.** The LLM is putting a recognizable pattern in the wrong cluster repeatedly — the cluster definition is wrong.

When you re-generate:
- Use a **larger, more recent sample** (`--sample 1000 --years 2`) so the new patterns dominate.
- **Diff** the new draft against your current doc. Most clusters should be the same; only add/rename/split where the diff reveals real change.
- **Bump `cluster_classify_v1` → `cluster_classify_v2`** in the prompt and `config.py` constant if the taxonomy changes meaningfully. This makes the old classifications invisible to the new version's reads while keeping them auditable (the `classifier_version`-tagging pattern — see `docs/ARCHITECTURE.md` "Cache invalidation via classifier_version").

---

## What the meta-prompt is allowed to do

`prompts/taxonomy_meta_v1.md` constrains the LLM to:

- 20–40 clusters, contiguous IDs.
- Cluster names are 2–6 words, describing relationship + intent.
- Each cluster has a 1–3 sentence definition, 2–4 example signals, and a `default_rating` from 0–9.
- **NO PII in cluster names or definitions.** If your sample reveals you correspond with "Acme Corp," the cluster is "Primary business — clients" not "Acme clients." If a friend appears by name, the cluster is "Longtime friends," not "Sarah." This keeps the taxonomy structural rather than personal.
- A short "Pre-classification auto-rules" section catching obvious patterns before the LLM runs (e.g. `noreply@*` → transactional).
- A short "Disambiguation rules" section covering at-most 5 common confusions.
- Reserve the last cluster for "Needs Review" for low-confidence cases.

The output is STRICT JSON; the `taxonomy_markdown` field carries the actual cluster doc that gets saved.

---

## Cluster IDs are stable; names can drift

Once `cluster_definitions` has a row at `cluster_id = 5`, downstream tables (`message_classifications`, `sender_classifications`, `routing_corrections`) FK back to it by ID. If you rename the cluster (`"Active client scheduling"` → `"Paying client logistics"`), updates to `cluster_definitions.cluster_name` propagate without breaking the FK relationship.

If you DROP a cluster, the existing classifications still reference its ID; either retire the cluster in-place (flag it with a `retired_at` column you add) or migrate the existing rows to a survivor cluster.

---

## Where this fits in the bigger picture

- `tools/taxonomy_generator.py` — this workflow (Phase 3 of [`SETUP.md`](../SETUP.md)).
- `prompts/taxonomy_meta_v1.md` — the meta-prompt the generator uses.
- `prompts/cluster_classify_v1.md` — the prompt the runtime classifier uses, wrapping the doc you produced.
- `services/.../cluster_classifier.py` — the runtime per-message classifier.
- `services/.../ratings.py` `CLUSTER_DEFAULT_RATING` — the cluster_id → default_rating map you populate by hand.
- `migrations/00_warehouse_schema.sql` `cluster_definitions` — the warehouse-side authoritative cluster list.

For the rating-side workflow (what 0–9 means), see [`RATING_SCALE.md`](RATING_SCALE.md). For the self-refining routing prompt (a related pattern applied to a different classifier), see [`PROMPT_REFINEMENT.md`](PROMPT_REFINEMENT.md).
