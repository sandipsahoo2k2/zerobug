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

### 2. Clone and run the dashboard locally

```bash
cd frontend && npm ci && npm start
```

Open <http://localhost:4200>.

### 3. Configure the repository

**Settings → Secrets and variables → Actions → Variables**

| Variable | Example | Meaning |
| --- | --- | --- |
| `JIRA_BASE_URL` | `https://acme.atlassian.net` | Jira site, used by the MCP server and the REST fallback |
| `JIRA_MCP_COMMAND` | `npx` | Command that launches your Jira MCP server over stdio |
| `JIRA_MCP_ARGS` | `-y,mcp-atlassian` | Comma-separated args for that command |
| `ZEROBUG_MODEL` | `openai/gpt-4.1` | Model used only by the GitHub Models fallback |

Leave `JIRA_MCP_COMMAND` empty to skip MCP entirely and use the Jira REST API directly.

**Settings → Secrets and variables → Actions → Secrets**

| Secret | Meaning |
| --- | --- |
| `JIRA_EMAIL` | Atlassian account email |
| `JIRA_API_TOKEN` | Atlassian API token |
| `COPILOT_TOKEN` | *Optional.* GitHub PAT of an account with a Copilot seat. Present → Copilot CLI session. Absent → GitHub Models API with the built-in `GITHUB_TOKEN`. |

### 4. Enable GitHub Pages

**Settings → Pages → Source: GitHub Actions.** Push to `main`; `deploy-pages.yml` builds the
Angular app with `--base-href /<repo>/` and publishes it. The dashboard lands at
`https://<owner>.github.io/<repo>/`.

### 5. Create the dashboard token

The browser needs permission to start a workflow run. Create a **fine-grained PAT**, scoped to
this repository only:

- `Actions: read and write` — dispatch the workflow and poll runs
- `Contents: read` — read `plans/<JIRA-ID>.json`

Paste it into the dashboard's **Settings** panel. It is stored in that browser's `localStorage`
and sent only to `api.github.com`. Jira credentials never reach the browser.

> If you would rather not keep a GitHub token in a browser at all, run the dashboard only on
> `localhost` and skip step 4.

### 6. Use it

1. Enter a Jira ID, e.g. `ZB-123`, press **Analyse defect**.
2. The dashboard dispatches `zerobug-plan.yml` in `plan` mode and follows the run.
3. When the run finishes, the plan is read from the `zerobug-plans` branch and rendered:
   root cause hypothesis, suspect files, related commits, numbered fix steps with per-step
   validation, tests, rollback.
4. Press **Publish plan to Jira**. That re-dispatches in `publish` mode, which appends the plan to
   the issue description (replacing any block a previous ZeroBug run left there).
5. **Load saved plan** re-reads a stored plan without spending a run.

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
