# ZeroBug

Find and fix defects in your repo.

Type a Jira ID into a dashboard. GitHub Actions reads the issue through a **Jira MCP server**,
runs a **GitHub Copilot session** over the repository — source, history, past commits touching the
same files — and produces a **step-by-step fix plan**. The plan is shown in the dashboard and, on
one click, written back into the Jira issue description.

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
      |-- Jira MCP server (stdio)              -> read issue JIRA-123
      |-- repo context: log, hotspots, commits mentioning JIRA-123, keyword grep
      |-- GitHub Copilot CLI session (headless) -> step-by-step plan as JSON
      |-- mode=publish: Jira MCP               -> write plan into the issue description
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
- Optional: a GitHub Copilot seat, if you want the Copilot CLI session rather than the
  GitHub Models fallback.

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
| `ZEROBUG_ENGINE` | `agent` | `agent` (default) = Copilot coding agent session; `copilot` = headless Copilot CLI in the runner |
| `JIRA_MCP_COMMAND` | *(leave empty)* | Optional. Command that launches a Jira MCP server over stdio |
| `JIRA_MCP_ARGS` | *(leave empty)* | Optional. Comma-separated args for that command |

**Start with the MCP variables empty.** `jira.mjs` then talks to the Jira Cloud REST API
directly — same read and same description write, nothing to install on the runner.

Set them only when you want an MCP server in the loop. The one most people mean,
`sooperset/mcp-atlassian`, is a **Python** package, so it is `uvx`, not `npx`:

```
JIRA_MCP_COMMAND = uvx
JIRA_MCP_ARGS    = mcp-atlassian
```

and the workflow then needs a `astral-sh/setup-uv@v5` step before the analysis step.

**Settings → Secrets and variables → Actions → Secrets**

| Secret | Meaning |
| --- | --- |
| `JIRA_EMAIL` | Atlassian account email |
| `JIRA_API_TOKEN` | Atlassian API token |
| `AGENT_TOKEN` | Needed by `ZEROBUG_ENGINE=agent`. A PAT that can create issues in this repo and assign `copilot-swe-agent` to them. The built-in `GITHUB_TOKEN` cannot start an agent session. |
| `COPILOT_TOKEN` | Needed by `ZEROBUG_ENGINE=copilot`. Fine-grained PAT with the **Copilot Requests** account permission, from an account with a Copilot seat. |

Both engines need Copilot entitlement — one as a token you hold, the other as a seat GitHub
checks server-side. There is no fallback engine: GitHub Models used to be one, it is being
retired and now answers `410 github_models_retirement_brownout`, and a plan produced without
real access to the code is not worth writing into a ticket.

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

1. Enter a Jira ID, e.g. `ZB-123`, press **Analyse defect**.
2. The dashboard dispatches `zerobug-plan.yml` in `plan` mode and follows the run.
   With `ZEROBUG_ENGINE=agent` the run finishes in seconds — it only opens a tracking issue and
   assigns the Copilot coding agent. The session then works on GitHub's side and opens a pull
   request adding `plans/<JIRA-ID>.json`; the dashboard watches for that PR and links to it.
3. When the plan appears — on the `zerobug-plans` branch, on `main`, or on the agent's PR
   branch — it is rendered:
   root cause hypothesis, suspect files, related commits, numbered fix steps with per-step
   validation, tests, rollback.
4. Press **Publish plan to Jira**. That re-dispatches in `publish` mode, which appends the plan to
   the issue description (replacing any block a previous ZeroBug run left there).
5. **Load saved plan** re-reads a stored plan without spending a run.

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
    jira.mjs                       Jira MCP client, with REST fallback + ADF conversion
    context.mjs                    git history, hotspots, keyword grep
    plan.mjs                       Copilot CLI session / GitHub Models, plan schema, Markdown
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
  "jiraUpdated": false
}
```

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
  declared input schema.
- Publishing replaces the ZeroBug block in the description and preserves everything above it.
