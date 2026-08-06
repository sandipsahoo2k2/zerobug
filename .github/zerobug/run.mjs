import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildRepoContext } from './context.mjs';
import { readIssue, updateDescription } from './jira.mjs';
import { generatePlan, mergeIntoDescription } from './plan.mjs';

/**
 * Entry point for the ZeroBug workflow.
 *   mode=plan    -> read Jira, run the Copilot session, write plans/<JIRA-ID>.json
 *   mode=publish -> reuse the stored plan (or make one) and write it into the Jira description
 */

const jiraId = (process.env.JIRA_ID ?? '').trim().toUpperCase();
const mode = (process.env.MODE ?? 'plan').trim().toLowerCase();
const outputPath = process.env.PLAN_OUTPUT ?? join(process.env.RUNNER_TEMP ?? '.', 'plan.json');
const existingPlanPath = process.env.EXISTING_PLAN_PATH ?? '';

if (!/^[A-Z][A-Z0-9]+-\d+$/.test(jiraId)) {
  console.error(`Invalid Jira ID: "${jiraId}". Expected something like ZB-123.`);
  process.exit(1);
}

const log = (message) => console.log(`[zerobug] ${message}`);

const loadStoredPlan = () => {
  if (!existingPlanPath || !existsSync(existingPlanPath)) return null;
  try {
    return JSON.parse(readFileSync(existingPlanPath, 'utf8'));
  } catch {
    return null;
  }
};

async function main() {
  log(`issue ${jiraId}, mode ${mode}`);

  const issue = await readIssue(jiraId);
  log(`Jira read via ${issue.source}: ${issue.summary}`);

  let plan = mode === 'publish' ? loadStoredPlan() : null;

  if (plan) {
    log('Reusing the stored plan.');
  } else {
    log('Collecting repository context…');
    const repoContext = buildRepoContext(jiraId, issue);
    log(`Context: ${repoContext.length} chars. Starting the analysis session…`);
    plan = await generatePlan(issue, repoContext);
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
