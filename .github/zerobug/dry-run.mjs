/**
 * Local harness: exercises the real context gathering and prompt building without a
 * Jira server or a Copilot seat.
 *
 *   node .github/zerobug/dry-run.mjs ZB-101 fixtures/issue.json
 *
 * Prints the exact prompt the Copilot session receives in CI, so you can sanity-check
 * what the analysis is actually looking at before spending an Actions run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildRepoContext } from './context.mjs';
import { buildPrompt } from './plan.mjs';

const [jiraId, issuePath, promptOut] = process.argv.slice(2);

if (!jiraId || !issuePath) {
  console.error('usage: node dry-run.mjs <JIRA-ID> <issue.json> [prompt-out.txt]');
  process.exit(1);
}

const issue = { key: jiraId, status: '', priority: '', labels: [], ...JSON.parse(readFileSync(issuePath, 'utf8')) };
const context = buildRepoContext(jiraId, issue);
const prompt = buildPrompt(issue, context);

if (promptOut) {
  writeFileSync(promptOut, prompt);
  console.log(`prompt written to ${promptOut} (${prompt.length} chars)`);
} else {
  console.log(prompt);
}
