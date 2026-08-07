import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assignToAgent, buildAgentBrief, createIssue, findCopilotAgent } from './agent.mjs';
import { buildRepoContext } from './context.mjs';
import { readIssue, updateDescription } from './jira.mjs';
import { SCHEMA, generatePlan, mergeIntoDescription } from './plan.mjs';

/**
 * Entry point for the ZeroBug workflow.
 *
 * Engines (ZEROBUG_ENGINE):
 *   claude  -> Anthropic API call from this runner. Needs no Copilot entitlement; the repo
 *              context carries the suspect source inline since the model cannot browse.
 *   agent   -> opens a GitHub issue and assigns it to the Copilot coding agent. The session
 *              runs on GitHub's side and opens a PR containing plans/<JIRA-ID>.json, so this
 *              job finishes in seconds and the plan lands minutes later.
 *   copilot -> headless Copilot CLI session inside this runner; the plan is ready when the
 *              job ends.
 *
 * Modes:
 *   plan    -> produce the plan
 *   publish -> write an existing plan into the Jira description
 */

const jiraId = (process.env.JIRA_ID ?? '').trim().toUpperCase();
const mode = (process.env.MODE ?? 'plan').trim().toLowerCase();
const engine = (process.env.ZEROBUG_ENGINE ?? 'agent').trim().toLowerCase();
const outputPath = process.env.PLAN_OUTPUT ?? join(process.env.RUNNER_TEMP ?? '.', 'plan.json');
const existingPlanPath = process.env.EXISTING_PLAN_PATH ?? '';

if (!/^[A-Z][A-Z0-9]+-\d+$/.test(jiraId)) {
  console.error(`Invalid Jira ID: "${jiraId}". Expected something like ZB-123.`);
  process.exit(1);
}

const log = (message) => console.log(`[zerobug] ${message}`);

const summary = (line) => {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
};

const loadStoredPlan = () => {
  if (!existingPlanPath || !existsSync(existingPlanPath)) return null;
  try {
    return JSON.parse(readFileSync(existingPlanPath, 'utf8'));
  } catch {
    return null;
  }
};

/** Hands the work to the Copilot coding agent and returns without a plan. */
async function dispatchAgentSession(issue) {
  const token = process.env.AGENT_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
  if (!token) throw new Error('AGENT_TOKEN is not set — the coding agent cannot be assigned.');

  log('Checking whether the Copilot coding agent is assignable here…');
  const agent = await findCopilotAgent(owner, repo, token);
  if (!agent) {
    throw new Error(
      'copilot-swe-agent is not assignable in this repository. That means either the account ' +
        'behind AGENT_TOKEN has no Copilot seat, or the coding agent is disabled for this repo ' +
        '(Settings -> Copilot -> Coding agent), or the token lacks Issues write access.',
    );
  }

  const repoContext = buildRepoContext(jiraId, issue);
  const created = await createIssue(owner, repo, token, {
    title: `[${jiraId}] ${issue.summary}`,
    body: buildAgentBrief(jiraId, issue, repoContext, SCHEMA),
  });
  log(`Tracking issue #${created.number}: ${created.html_url}`);

  await assignToAgent(created.node_id, agent.id, token);
  log('Assigned to the Copilot coding agent — the session is starting.');

  summary(`Agent session started from issue #${created.number}: ${created.html_url}`);
  summary('The plan arrives as a pull request adding `plans/' + jiraId + '.json`.');
}

async function main() {
  log(`issue ${jiraId}, mode ${mode}, engine ${engine}`);

  const issue = await readIssue(jiraId);
  log(`Jira read via ${issue.source}: ${issue.summary}`);

  if (engine === 'agent' && mode === 'plan') {
    await dispatchAgentSession(issue);
    return;
  }

  let plan = mode === 'publish' ? loadStoredPlan() : null;

  if (plan) {
    log('Reusing the stored plan.');
  } else if (mode === 'publish') {
    throw new Error(
      `No stored plan for ${jiraId}. Merge the agent's pull request, or run mode=plan first.`,
    );
  } else {
    log('Collecting repository context…');
    const repoContext = buildRepoContext(jiraId, issue);
    log(`Context: ${repoContext.length} chars. Starting the analysis session…`);
    plan = await generatePlan(issue, repoContext, engine);
    log(`Plan ready: ${plan.steps.length} steps, risk ${plan.riskLevel}.`);
  }

  if (mode === 'publish') {
    const description = mergeIntoDescription(issue.description, plan);
    const via = await updateDescription(jiraId, description);
    plan.jiraUpdated = true;
    log(`Jira description updated via ${via}.`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(`[zerobug] failed: ${error.message}`);
  process.exit(1);
});
