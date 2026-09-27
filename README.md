# ZeroBug

Find and fix defects in your repo.

Type a Jira ID into a dashboard. GitHub Actions reads the issue from **Jira** (REST by default,
or an MCP server if you configure one), runs a **GitHub Copilot session** over the repository —
source, history, past commits touching the same files — produces a **step-by-step fix plan**,
works out **who knows that code** from git history, and on one click writes the plan back into
the Jira issue and **assigns the ticket** to that developer.

End to end:

```
Jira issue  --REST or MCP-->  repo context  --GitHub Copilot-->  fix plan
                                                                    |
                                    git blame + git log  -->  owners  -->  assignee
                                                                    |
                            REST or MCP  -->  Jira description + assignment
```

Every model call is GitHub Copilot. There is no fallback to any other LLM, on purpose — see
[Copilot only](#copilot-only-no-model-fallback).

There is **no server to host**. The dashboard is a static Angular app on GitHub Pages; all compute
runs in GitHub Actions; all credentials live in GitHub Actions secrets.

---

## Architecture

```
GitHub Pages  (Angular 22 dashboard)
      |
      |  REST: POST /actions/workflows/zerobug-plan.yml/dispatches   { jira_id, mode }
      v
GitHub Actions runner  (workflow: ZeroBug plan)
      |-- actions/checkout, fetch-depth 0      -> full source + full git history
      |-- Jira REST (default) or MCP (stdio)   -> read issue JIRA-123
      |-- repo context: log, hotspots, commits mentioning JIRA-123, keyword grep
      |-- one GitHub Copilot session:
      |     ZEROBUG_ENGINE=copilot  -> headless Copilot CLI here in the runner
      |     ZEROBUG_ENGINE=agent    -> Copilot coding agent on GitHub, opens a PR
      |                                                -> step-by-step plan as JSON
      |-- owners.mjs: git blame + git log        -> who knows the suspect files
      |-- mode=publish: Jira REST or MCP         -> write plan into the description
      |                                          -> assign the issue to the top owner
      `-- commit plans/JIRA-123.json to branch `zerobug-plans`
      |
      |  REST: GET /actions/runs (poll)  +  GET /contents/plans/JIRA-123.json
      v
GitHub Pages dashboard renders the plan
```

Why this shape: Jira Cloud sends no CORS headers for API-token auth, an MCP server is a local
process, and Copilot has no browser-callable API — so a purely static page cannot do any of it.
The Actions runner is the "backend", and it is free and already authorised against the repo.

---

## Step by step

### 1. Prerequisites

- Node 22.22.3+ or 24+ (the Angular 22 CLI refuses older Node).
- A Jira Cloud site and an API token — <https://id.atlassian.com/manage-profile/security/api-tokens>.
- A GitHub Copilot seat. Both engines are Copilot and there is no fallback model, so a run
  cannot produce a plan without one.

### 2. Create the Jira site, project, ticket and token

**a. Site** — skip if you already have one. <https://www.atlassian.com/software/jira/free> → sign
up. You land on `https://<yourname>.atlassian.net`. That whole URL is `JIRA_BASE_URL`.

**b. Project** — *Projects → Create project → Kanban → team-managed*. Name it whatever; set the
**key** to something like `ZB`. The key becomes the ticket prefix, and ZeroBug validates keys
against `^[A-Z][A-Z0-9]+-[0-9]+$`, so use two or more letters.

**c. Ticket** — *Create → Issue type: Bug*. To try it against the defect bundled in this repo,
use the summary and description in [Try it on the bundled defect](#try-it-on-the-bundled-defect).
Saving gives you a key such as `ZB-1` — that is what you type into the dashboard.

**d. API token** — <https://id.atlassian.com/manage-profile/security/api-tokens> → *Create API
token* → label it → copy it once. The token authenticates as you, so your account needs
**Edit Issues** on that project for the publish step to write the description back.

### 3. Clone and run the dashboard locally

```bash
cd frontend && npm ci && npm start
```

Open <http://localhost:4200>.

### 4. Configure the repository

**Settings → Secrets and variables → Actions → Variables**

| Variable | Example | Meaning |
| --- | --- | --- |
| `JIRA_BASE_URL` | `https://acme.atlassian.net` | Jira site, used by the MCP server and the REST fallback |
| `ZEROBUG_ENGINE` | `copilot` | `copilot` (default) = headless Copilot CLI in the runner; `agent` = Copilot coding agent session on GitHub. Both are GitHub Copilot — there is no other engine, see below |
| `DEFAULT_ASSIGNEE` | *(empty)* | Jira accountId the ticket falls back to when git history gives no clear owner. The dashboard's Settings panel overrides it per run |
| `JIRA_MCP_COMMAND` | *(leave empty)* | Optional. Command launching a Jira MCP server over stdio. **Empty = Jira REST API, which is the working default** |
| `JIRA_MCP_ARGS` | *(leave empty)* | Optional. Comma-separated args for that command |

**Which Jira backend runs.** Leave `JIRA_MCP_COMMAND` empty and `jira.mjs` talks to the **Jira
Cloud REST API** directly — that is the default and the path this repo is set up on. Set the
variable and it launches an MCP server over stdio instead. Both backends do all three
operations — read the issue, write the description, assign the issue — so the flow is identical
either way, and nothing else in the pipeline knows the difference. The log line
`Jira read via rest` vs `Jira read via mcp:<tool>` tells you which one served the run.

For MCP, the server most people mean is `sooperset/mcp-atlassian`, a **Python** package, so it
is `uvx`, not `npx`:

```
JIRA_MCP_COMMAND = uvx
JIRA_MCP_ARGS    = mcp-atlassian
```

The workflow installs `uv` itself when `JIRA_MCP_COMMAND` starts with `uvx`; an `npx`-based
server needs nothing extra. The server inherits the runner's environment, which is where it
picks up `JIRA_URL`, `JIRA_USERNAME` and `JIRA_API_TOKEN`.

Tool names differ between Jira MCP servers, so `jira.mjs` matches on intent (`/issue/` plus
`/get|read/`, `/update|edit/`, `/assign/`) and maps arguments off each tool's declared input
schema. If a server exposes no assign tool, it falls back to that server's generic issue update.

**Settings → Secrets and variables → Actions → Secrets**

| Secret | Meaning |
| --- | --- |
| `JIRA_EMAIL` | Atlassian account email |
| `JIRA_API_TOKEN` | Atlassian API token |
| `COPILOT_TOKEN` | Used by the default `copilot` engine. Fine-grained PAT with the **Copilot Requests** account permission, from an account with a Copilot seat. |
| `AGENT_TOKEN` | Needed by `ZEROBUG_ENGINE=agent`. A PAT that can create issues in this repo and assign `copilot-swe-agent` to them. The built-in `GITHUB_TOKEN` cannot start an agent session. |

### Copilot only: no model fallback

Deliberate. We do not want a local or third-party LLM writing code for this repo; GitHub
Copilot should work. If a run fails because Copilot could not run (no Copilot seat, expired
token, CLI failure), the run fails loudly and the fix is the credential. Do not add an
Anthropic — or any other — API key back in as a fallback; `plan.mjs`, `run.mjs` and the
workflow all say so at the point where someone would be tempted to.

Setting `ZEROBUG_ENGINE` to anything but `copilot` or `agent` exits 1 with that reason.

**Both engines require Copilot entitlement** — the CLI as a token you hold, the coding agent as
a seat GitHub checks server-side. The plan's `engine` field records what produced it
(`copilot-cli` or `copilot-swe-agent`).

### Choosing an engine

| | `copilot` (default) | `agent` |
| --- | --- | --- |
| Where the session runs | Copilot CLI inside this Actions runner | GitHub's infrastructure, visible in the repo's **Agents → Sessions** tab |
| Run length | 1–4 min, plan ready when the job ends | seconds — the job only files a tracking issue and assigns `copilot-swe-agent` |
| How the plan arrives | committed to the `zerobug-plans` branch | a pull request adding `plans/<JIRA-ID>.json` (and optionally the code fix) |
| Credential | `COPILOT_TOKEN` | `AGENT_TOKEN` (a real user PAT) |
| Reads the repo | opens files itself in the checkout | opens files itself in its own checkout |

`context.mjs` inlines the source of the files the keyword search points at either way, so both
sessions start with the suspect code already in front of them rather than just file names.

### 5. Enable GitHub Pages

Two options; the workflow in this repo uses the second.

- **Source: GitHub Actions** — the Pages artifact API. Cleanest, but the setting must be
  switched from the default.
- **Source: Deploy from a branch → `gh-pages` / `(root)`** — what `deploy-pages.yml` publishes
  to. Build output is force-pushed to `gh-pages` on every push to `main` that touches
  `frontend/`.

Either way the dashboard lands at `https://<owner>.github.io/<repo>/`.

### 6. Create the dashboard token

The browser needs permission to start a workflow run. Create a **fine-grained PAT**, scoped to
this repository only:

- `Actions: read and write` — dispatch the workflow and poll runs
- `Contents: read` — read `plans/<JIRA-ID>.json`

Paste it into the dashboard's **Settings** panel. It is stored in that browser's `localStorage`
and sent only to `api.github.com`. Jira credentials never reach the browser.

> If you would rather not keep a GitHub token in a browser at all, run the dashboard only on
> `localhost` and skip step 5.

### 7. Use it

1. Enter a Jira ID, e.g. `ZB-123`, and optionally check **Also create a PR with the fix**. Press **Analyse defect**.
2. The dashboard dispatches `zerobug-plan.yml` in `plan` mode and follows the run.
   With `ZEROBUG_ENGINE=agent` the run finishes in seconds — it only opens a tracking issue and
   assigns the Copilot coding agent. The session then works on GitHub's side and opens a pull
   request adding `plans/<JIRA-ID>.json`; the dashboard watches for that PR and links to it.
3. When the plan appears — on the `zerobug-plans` branch, on `main`, or on the agent's PR
   branch — it is rendered:
   root cause hypothesis, suspect files, related commits, numbered fix steps with per-step
   validation, tests, rollback.
4. Press **Publish plan to Jira**. That re-dispatches in `publish` mode, which appends the plan to
   the issue description (replacing any block a previous ZeroBug run left there) **and assigns
   the Jira issue** to the developer the git history points at.
5. **Load saved plan** re-reads a stored plan without spending a run.

### The agent flow, step by step

With `ZEROBUG_ENGINE=agent`, one defect takes two dispatches:

| # | What happens | Where you see it |
| --- | --- | --- |
| 1 | **Analyse defect** → `mode=plan`. `run.mjs` reads Jira, builds repo context, files a tracking issue titled `[ZB-123] <summary>`, assigns `copilot-swe-agent`. Job ends in seconds. | Actions run, then repo **Issues** |
| 2 | The coding agent session opens the repo, reads code and history, writes `plans/ZB-123.json`, opens a PR titled `ZeroBug plan for ZB-123`. If the fix option was checked, this PR also contains the code fix. | repo **Agents → Sessions**, then **Pull requests** |
| 3 | The dashboard finds that PR by Jira ID and renders the plan straight off its head branch. | dashboard |
| 4 | **Publish plan to Jira** → `mode=publish`. Reads the same plan (plans branch, `main`, *or the open PR's branch*), normalises it, ranks owners from git, writes the description, assigns the Jira issue. | Actions run, then Jira |

**You do not have to merge the agent's PR first.** Publish looks on the PR branch too. Merging
it is still worth doing — it puts the plan on `main` permanently, and the plans branch keeps a
copy after any publish run.

**Ownership and assignment happen at step 4, not step 2.** The agent never sees your Jira
account map and never picks an assignee — `owners.mjs` does that from `git blame` and `git log`
during the publish run. So a plan you are looking at in step 3 has no owners on it yet; that is
expected, not a failure.

**Prerequisites specific to this engine:**

- Repo **Settings → Copilot → Coding agent** enabled.
- `AGENT_TOKEN` = a user PAT with **Issues: write** on this repo, from an account holding a
  Copilot seat. `GITHUB_TOKEN` cannot start an agent session, and `run.mjs` preflights this with
  a GraphQL `suggestedActors` query so a missing entitlement fails with that exact wording
  rather than a silent no-op.
- `.github/zerobug/owners.json` mapping git emails to Jira accountIds — without it, assignment
  falls back to `DEFAULT_ASSIGNEE` or leaves the ticket unassigned. See
  [Who gets the ticket](#who-gets-the-ticket).

---

## Who gets the ticket

Once a plan names its suspect files, `owners.mjs` ranks who knows that code from the
repository's own history — no model involved, since the history is a fact.

Two signals per suspect file, combined:

- **`git blame -w -C`** — how much of the file a person actually wrote. `-w` ignores
  whitespace-only changes and `-C` follows code moved between files; without both, blame
  credits whoever last reformatted.
- **`git log --follow`** — commits touching the file, weighted by recency on a 180-day
  half-life, so someone active last week outranks someone who touched it once a year ago.

Bots are filtered. `users.noreply.github.com` is a real person's privacy address and is kept;
bare `noreply@github.com` is automation and is dropped.

The plan carries the top three with a one-line justification each, and the same list is written
into the Jira description — so whoever picks up the ticket knows who to ask.

### Assignment

The top-ranked person gets the ticket, but only when the history is unambiguous. It falls back
to the **default assignee** — set in the dashboard's Settings, or repo variable
`DEFAULT_ASSIGNEE` — in four cases:

| Case | Why |
| --- | --- |
| Scores tie | No basis to pick between them |
| Top candidate is stale (>1 year) | They have most likely moved on |
| No Jira account mapped for their git email | Guessing an accountId is never acceptable |
| History names nobody | Nothing to go on |

Map git emails to Jira accounts in `.github/zerobug/owners.json`:

```json
{ "someone@example.com": "5b10a2844c20165700ede21g" }
```

An unmapped author is still ranked and still shown — only the assignment falls back.

**This ranks code familiarity, not who should do the work.** Git cannot see workload, leave, or
team boundaries. Assignment is a starting point with its reasoning attached, not a verdict —
both the plan and the Jira description say so.

---

## Try it on the bundled defect

`sample-app/` exists so you can exercise the whole thing without inventing a bug.

**The defect.** `docs/pricing-rules.md` says the 100 and 500 discount thresholds are
*inclusive* and coupons are valid *up to and including* `expiresAt`. Commit `ff4ddce`
"refactor(pricing): table-driven tier lookup" — message says *behaviour unchanged* — flipped
`>=` to `>` and `<=` to `<`. All 5 tests still pass, because none of them sits on a boundary:

```bash
cd sample-app && node --test        # 5 pass, defect present
```

**The Jira ticket to raise.** Create a bug in your project with:

> **Summary:** Orders of exactly 100.00 are charged full price instead of getting the 10% tier discount
>
> **Description:**
> Steps to reproduce:
> 1. Add items to a cart until the subtotal is exactly 100.00
> 2. Go to checkout
>
> Expected: 10% tier discount is applied, total 90.00 (docs/pricing-rules.md says thresholds are inclusive).
> Actual: no discount, total 100.00.
>
> Same thing happens at exactly 500.00 — it gets 10% instead of 20%.
>
> A customer also reported a loyalty coupon being rejected on its expiry date, which the rules say should still be valid. Started somewhere in the last few releases; it used to work.

Then enter that issue's key in the dashboard and press **Analyse defect**.

The context step feeds the session `sample-app/src/pricing.js:18` — the buggy comparison
itself — along with both pricing commits, so the analysis starts with the regression in view.

---

## Layout

```
frontend/                          Angular 22 dashboard
  src/app/
    core/models/                   FixPlan, WorkflowRun, ZeroBugSettings
    core/services/
      settings.service.ts          repo coordinates + token, persisted to localStorage
      github-api.service.ts        thin GitHub REST wrapper (dispatch, runs, plan file)
      zerobug.service.ts           job orchestration: dispatch -> poll run -> fetch plan
    features/
      dashboard/                   Jira ID input, run status, actions
      plan-view/                   renders one FixPlan
      settings-panel/              repo + token configuration
.github/
  workflows/
    zerobug-plan.yml               the "backend": dispatch-triggered analysis job
    deploy-pages.yml               builds and publishes the dashboard
  zerobug/
    run.mjs                        orchestrator invoked by the workflow
    jira.mjs                       Jira REST client (default) + MCP client, ADF conversion
    context.mjs                    git history, hotspots, keyword grep, inlined source
    plan.mjs                       Copilot CLI session, plan schema, JSON -> Markdown
    agent.mjs                      Copilot coding agent: brief, tracking issue, assignment
    owners.mjs                     blame + log ranking, assignee resolution
    owners.json                    git email -> Jira accountId map
```

Angular follows the standard split: **components** hold no data-fetching logic, **services** own
all state (signals) and all I/O, models are plain interfaces. Components are standalone,
`OnPush`, zoneless, and use the built-in `@if` / `@for` control flow.

---

## The plan format

`plans/<JIRA-ID>.json` on the `zerobug-plans` branch:

```json
{
  "jiraId": "ZB-123",
  "summary": "Login fails for expired refresh tokens",
  "generatedAt": "2026-08-06T02:44:42.960Z",
  "engine": "copilot-cli",
  "riskLevel": "medium",
  "rootCauseHypothesis": "…",
  "suspectFiles": [{ "path": "src/auth/token.service.ts", "reason": "…" }],
  "relatedCommits": [{ "sha": "9f2c1ab", "subject": "…" }],
  "steps": [
    { "n": 1, "title": "…", "detail": "…", "files": ["…"], "validation": "…" }
  ],
  "tests": ["…"],
  "rollback": "…",
  "owners": [
    { "name": "…", "email": "…", "score": 0.82, "blameShare": 0.61, "commits": 7,
      "lastTouched": "2026-07-30", "stale": false, "files": ["…"], "reason": "…" }
  ],
  "assignment": { "assignee": "5b10a2…", "via": "blame", "why": "…", "applied": true },
  "jiraUpdated": false
}
```

`engine` is `copilot-cli` or `copilot-swe-agent`. `owners` and `assignment` are filled in
during the publish run, so a plan the coding agent has just committed carries `[]` and `null`
until then. Every plan read back off a branch is re-normalised before use, so a missing key in
agent-written JSON cannot break publishing.

---

## Analysing a different repository

The workflow analyses the repository it lives in. To point it at another codebase, either drop
`.github/zerobug/` and `.github/workflows/zerobug-plan.yml` into that repo, or add a second
`actions/checkout` step for it and set `GITHUB_WORKSPACE` for the analysis step to that path.

## Notes and limits

- One dispatch = one Actions run, typically 1–4 minutes; the dashboard polls every 4s and gives up
  after 15 minutes.
- Workflow inputs are never interpolated into shell scripts — they pass through env vars and are
  validated against `^[A-Z][A-Z0-9]+-[0-9]+$` before use.
- Tool names differ between Jira MCP servers, so `jira.mjs` matches tools by intent
  (`/issue/` + `/get|read/`, `/issue/` + `/update|edit/`) and maps arguments off each tool's
  declared input schema. The default REST path needs none of this.
- Publishing replaces the ZeroBug block in the description and preserves everything above it.
- `publish` never generates a plan. With no stored plan it fails and tells you to run `plan`
  first — deliberate, so a publish click cannot silently spend a Copilot session.
- `publish` needs no Copilot credential at all, and skips installing the CLI.
- The workflow runs the scripts from `.github/zerobug`, but every path in a plan is relative to
  the repository root. `context.mjs` and `owners.mjs` anchor their git calls and file reads to
  `GITHUB_WORKSPACE` (falling back to `git rev-parse --show-toplevel`) so grep, hotspots and
  blame cover the whole repo rather than ZeroBug's own scripts.
- Each `plan` dispatch on the `agent` engine files a **new** tracking issue. Re-analysing the
  same Jira ID three times leaves three issues and three agent PRs; close the stale ones.
