You are designing a personal email-classification taxonomy. You will receive a random representative sample of one user's email archive — 100–800 messages drawn from across multiple years and a wide variety of senders. Your job: propose a cluster taxonomy (20–40 distinct clusters) that captures the structural patterns in THIS specific user's inbox.

# The role of the taxonomy

Downstream, a `cluster_classifier` will use this taxonomy to assign every incoming email to exactly one cluster. The cluster_id then drives:
- The user's default rating per cluster (e.g. "newsletters → rating 1, family → rating 9").
- Display + filtering decisions in the Mailspring plugin.
- Person-identity rollups (which kind of relationship is this).

So the taxonomy should:
- **Reflect this user's actual life**, not a generic email pattern. If the user runs a coaching business, you should see clusters for coaching prospects, paying clients, coaching-business platforms. If they're a hobbyist photographer with no business, the taxonomy looks very different.
- **Be operationally useful** — distinguish things the user would handle differently. Two clusters that get treated identically should merge.
- **Have a meaningful tail** — include the noisy stuff (newsletters, transactional, cold pitches, automated notifications) so they can be filtered out.
- **Be reusable** — cluster definitions should be stable enough that mail patterns in coming months still fit.

# Constraints on your proposal

- **Cluster count**: 20–40. Lower than 20 = too coarse; higher than 40 = too granular.
- **Cluster IDs**: integers 1 through N, contiguous. Reserve `38` for "Needs Review" if you find your taxonomy can't confidently absorb every kind of mail in the sample.
- **Each cluster** needs: integer id, short name (2-6 words), 1-3 sentence definition, 2-4 example signal phrases (senders/subjects/contexts the LLM should look for), and a `default_rating` from 0-9 reflecting the 0-9 personal-priority scale defined in `docs/RATING_SCALE.md` (0 = skip, 9 = best friend).
- **NO PII in cluster names or definitions.** Use generic descriptors. If the user has a specific business named "Acme Corp," call the cluster "Primary business — clients" not "Acme clients." If the user has a specific friend Sarah, don't put Sarah by name in any cluster. The taxonomy is structural, not personal.
- **Use the user's apparent context** to inform structure — but redact specifics. E.g. if many emails appear to be from coaching prospects, include a "Coaching prospects" cluster. If many emails are from a specific platform, refer to it generically ("CRM platform notifications").

# Auto-rules section

In addition to the cluster definitions, propose a short "Pre-classification auto-rules" section that catches common patterns BEFORE the LLM has to think hard:

- `noreply@*` or `do-not-reply@*` → automated; usually transactional/newsletter cluster.
- Newsletter list-unsubscribe headers → newsletter cluster.
- The user's own outgoing addresses as sender → self-cluster (forwards, filing).
- Calendar invites → calendar cluster.

# Disambiguation section

Also propose a short "Disambiguation rules" section covering at-most 5 common confusions you noticed in the sample. Example: "An email from a vendor that's actually about a refund dispute → billing/refunds cluster, not vendor cluster."

# Output — STRICT JSON

```json
{
  "cluster_count": 28,
  "summary": "One-paragraph summary of what kind of user this taxonomy fits and the main category groupings you identified.",
  "taxonomy_markdown": "# Cluster definitions\n\n## Cluster 1 — <name>\n\n<1-3 sentence definition>\n\n**Default rating:** 7\n\n**Example signals:**\n- <sender pattern>\n- <subject pattern>\n- <context cue>\n\n## Cluster 2 — ...\n\n...\n\n## Cluster 38 — Needs Review (reserved)\n\nUse this when you cannot confidently assign...\n\n# Pre-classification auto-rules\n\n- ...\n\n# Disambiguation rules\n\n- ...",
  "open_questions": [
    "Several messages mentioned 'X' but I couldn't tell if it's a business or a personal hobby — please verify and adjust cluster 9 or 15."
  ]
}
```

The `taxonomy_markdown` field is the actual cluster document — the user will save it as `email_classification_instructions_universal.md` at the data root (the same level as `warehouse.sqlite`). Make it well-structured, easy to read, and complete.

Do NOT include code fences, prose outside the JSON, or other top-level keys. STRICT JSON ONLY.
