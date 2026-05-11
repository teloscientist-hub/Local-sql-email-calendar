# Relationship rating scale (0–9)

Authoritative for the `rating` column in `contacts_to_rate.csv` and the per-message rating set by `Ctrl+Option+<digit>`. The scale is intentionally personal-feeling, not corporate-feeling — each row is what you'd think when *seeing* a message from that person.

## The scale itself

| rating | meaning |
|---:|---|
| **9** | Best friends — never miss |
| **8** | Slightly less best friends |
| **7** | Friends |
| **6** | OK, I care about them |
| **5** | I kinda care about them |
| **4** | I want to pay them some attention |
| **3** | I should look at this — make sure there's nothing important here |
| **2** | Might skip, but probably will glance to make sure |
| **1** | Might be worth looking at |
| **0** | Skip — zero value |

The cutoff between "must read" and "scan" lives somewhere between 5 and 6 for most people.

## How the badge maps colors to ratings

The plugin's `person-band.jsx` renders a small colored pill with the digit. Default color mapping (tune in CSS via `rating-colors.js`):

- **9** — bright pink/red
- **7–8** — orange/red
- **5–6** — yellow/amber
- **3–4** — muted blue/teal
- **1–2** — gray
- **0** — invisible (no pill rendered)

Sustain saturation only at the highest ratings; let the rest stay muted so the inbox doesn't look like a Christmas tree.

## Default mapping from cluster + flags to rating

When you haven't rated a sender by hand but the system has a classification signal, the sidecar's `ratings.effective_rating_decision()` falls back through these tiers. The cluster → default-rating mapping is **per-deployment** — it lives in `services/mml-classifier/mml_classifier/ratings.py` `CLUSTER_DEFAULT_RATING`. The template ships an empty dict + a commented example shape; you populate it after running the taxonomy generator (see [`CLASSIFICATION_TAXONOMY.md`](CLASSIFICATION_TAXONOMY.md)).

The shape:

```python
CLUSTER_DEFAULT_RATING: dict[int, int] = {
    # cluster_id → integer rating 0–9
    1: 7,    # Longtime friends (without priority_friend flag)
    3: 9,    # Family (no manual rating)
    # ... map every cluster_id that appears in your cluster_definitions
}
```

## Override priority

When multiple signals apply, take the highest. From most-specific to least-specific (matching `ratings.effective_rating_decision()`):

1. **Latest `message_ratings` row** for this specific message (set by `Ctrl+Option+<digit>` keystroke). Beats everything below.
2. **Manual rating in `contacts_to_rate.csv`** — any value you set, never auto-overwrite.
3. **`zero_value_senders` membership** → 0. Overrides cluster defaults but not manual.
4. **`priority_friend = 1`** → floor of 8. (E.g., if the cluster default is 6 but the person is also `priority_friend`, rating = 8.)
5. **Family cluster** (per your taxonomy — typically `cluster_id = 3`) → 9.
6. **Other cluster default** from `CLUSTER_DEFAULT_RATING`.
7. **Default 0** if no signal applies.

## How to design your own scale

If the 0–9 above doesn't fit, change it. A few principles to keep:

- **An odd-length integer scale.** Even-length (1–10) makes people pick the safe middle. Odd-length (1–9) forces commitment one way or the other. (The system uses 0–9, with 0 as an explicit zero-value signal distinct from "unrated.")
- **Asymmetric meaning at the ends.** "Best friends" at 9 isn't symmetric with "skip" at 0. That's correct — the inbox is naturally skewed toward "skip."
- **A keystroke per rating.** `Ctrl+Option+0..9` covers 0–9. If you want 1–5, ignore the rest. If you want 1–100, you have the wrong design.
- **Personalize the wording.** The example reads "best friends," "I kinda care," etc. — written for the system author to understand. Write yours for *you*.

The badge in the inbox does the heavy lifting. The rating is just the number that drives the color.
