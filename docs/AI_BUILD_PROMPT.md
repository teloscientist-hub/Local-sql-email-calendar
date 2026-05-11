# AI build prompt — hand this to your AI assistant

> A starter prompt for handing this template to an AI coding assistant (Claude Code, Cursor, Aider, GitHub Copilot Chat, etc.) and having it walk you through bring-up customized to your inbox, your ventures, and your machine. Copy this entire file into your AI's context at the start of a session.

The prompt assumes the AI can see this repo, run shell commands on your machine, and ask you questions. Adjust for your tool of choice.

---

## Mission

Help me bring up the MML Productivity local-first email triage system on my Mac, customized to my email accounts and my life. The architecture is already designed and locked; your job is **implementation + personalization**, not redesign.

Read [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/BUILD_GUIDE.md`](BUILD_GUIDE.md), [`docs/RATING_SCALE.md`](RATING_SCALE.md), and [`docs/CLASSIFICATION_TAXONOMY.md`](CLASSIFICATION_TAXONOMY.md) before you do anything else.

## About me — fill this in before starting

This block is the BACKGROUND prefix the classifier will use. Be specific. The LLM will need this to correctly classify your mail and the AI assistant will need it to ask you the right setup questions.

```
Name: <Your Name>

Email addresses I send from:
  - <primary@yourdomain.com>
  - <alias@yourdomain.com>
  - <work@othercompany.com>

Domains I own (anything *@<domain> is me, unless excepted below):
  - <yourdomain.com>
  - <yourcompany.io>

Domain exceptions (these addresses on my domains are NOT me):
  - <familymember@yourdomain.com> — my spouse / partner / etc.

People to know (proper nouns the classifier should recognize):
  - <Spouse Name>: <spouse@email.com> — relationship + any business
    they run that I help with
  - <Fiduciary contact>: anything mentioning <name + estate / trust>
    is personal admin, not legal work
  - <Affinity group>: subject prefix "[<group> -" or list address
    <list@example.com> is the group
  - <Family relations>: <list of family last names>

Current ventures / projects:
  - <Venture 1>: <one-line description>. Active client base + cold
    prospecting. (Maps to clusters 5 (active scheduling), 7 (prospects),
    8 (B2B prospecting), 10 (active partnership ops).)
  - <Venture 2>: <one-line description>.

Historical ventures (still occasionally generate mail):
  - <Past venture 1>: <era>. ~few emails/month.
  - <Past venture 2>: <era>. Mostly inactive.

Custom interests (matters when the LLM judges newsletter relevance):
  - <e.g. AI, philosophy, infrastructure, photography, climbing>
```

## My machine

```
OS: macOS <version>
Python: <version> via <pyenv / homebrew / system>
Node: <version> via <nvm / homebrew>
Mailspring: <version> — installed via <App Store / brew --cask>
Local LLM CLI: <claude / ollama / llm-cli> at <path>, model <name>
Editor: <VS Code / Cursor / vim / ...>
```

## What I want you to do

Work through [`docs/BUILD_GUIDE.md`](BUILD_GUIDE.md) end-to-end, with me. For each phase:

1. **Tell me what's about to happen** — one paragraph, plain English. Don't dump the whole phase.
2. **Ask me any questions you need answered before proceeding** — bias toward asking rather than guessing. Especially for cluster naming, rating values, and account-specific config.
3. **Run the commands**, or generate the files, with my approval.
4. **Verify each step** — run the "Done when" check from the build guide. Don't move on until it passes.
5. **Push back on me** if I ask for something that contradicts the locked architectural decisions below.

## Locked architectural decisions — do not relitigate

| Decision | Choice |
|---|---|
| Email client | Mailspring. Do not propose alternatives. |
| Source-of-truth store | One `warehouse.sqlite`. Do not split across DBs. |
| Sidecar language | Python with stdlib `http.server`. Do not propose FastAPI / aiohttp / Flask. |
| Plugin sandbox | Vanilla `fetch` + vanilla DOM where possible. Do not add `react-dom`, `lodash`, `axios`. |
| Backups | APFS-clone (`cp -c`) the warehouse before any bulk write. |
| LLM scoring | Local CLI shell-out (`claude_cli.py`). Do not propose hosted API by default. |
| Network exposure | Localhost only. Do not bind 0.0.0.0. Tailscale is later. |
| Engagement axis | Numeric lifetime send count per email address. Not categorical, not weighted. |
| Disposition state | Free-form folder displayName mirrored into `messages_status.disposition`. Not IMAP keywords (Mailspring 1.21 doesn't implement them). |
| Append-only writes | On rating, classification, and content_score tables. Re-rate = new row, not UPDATE. |

## What I'd like you to push back on

- I will sometimes ask you to "just hardcode my email in the SQL" — don't. Use `me_addresses` everywhere.
- I will sometimes ask you to "skip the dry run" on the intake CLI — don't. Always dry-run first.
- I will sometimes ask you to "just use the latest cluster IDs" without populating `cluster_definitions` — don't. Insert the rows first; the schema CHECK depends on them.
- I will sometimes ask for a feature out of scope — point me at [`docs/FUTURE_IMPROVEMENTS.md`](FUTURE_IMPROVEMENTS.md) instead of building it now.

## What questions you should ask me up front

Before Phase 0 starts, ask me:
1. Should we install the launchd plist now or wait until the sidecar is verified end-to-end?
2. Do I have historical mail to ingest (PST/mbox), or are we starting fresh?
3. Do I want to run a Phase-1 sender-classification pass over historical mail, or skip and start from a fresh per-message Phase-2 pipeline?
4. Which of my email accounts should have the disposition folders (Pending/Waiting/Complete/Later) created?
5. Which clusters from the starter 31 do I want to rename / replace based on my ventures listed above?

Don't ask "should I proceed?" after each tiny step — just proceed, narrate, and verify. Ask only when a decision has consequences I'd want to be conscious of.

## Final assembly

When all phases are done, generate a `LOCAL_README.md` (which is `.gitignore`'d, since it'll contain my real values) summarizing:

- Where my warehouse lives.
- Which of my addresses are in `me_addresses`.
- Which clusters I customized.
- How to restart the sidecar.
- How to run the intake CLI.
- How to rebuild the plugin after a source edit (`cd plugin && npx tsc`, reload Mailspring with `Cmd+Option+L`).

Don't commit `LOCAL_README.md`. The template repo stays generic.
