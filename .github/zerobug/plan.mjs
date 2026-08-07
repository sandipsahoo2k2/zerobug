import { spawnSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Turns a Jira issue + repository context into a step-by-step fix plan.
 * Primary engine: a headless GitHub Copilot CLI session running inside the checked-out repo,
 * so it can open files and walk history itself. Fallback: the GitHub Models HTTP API.
 */

const env = process.env;

/** Marker that lets a later run find and replace the block it wrote before. */
const PLAN_HEADING = '## ZeroBug fix plan';

const SCHEMA = `{
  "summary": "one line restating the defect",
  "riskLevel": "low | medium | high",
  "rootCauseHypothesis": "2-4 sentences naming the most likely cause, referencing real files",
  "suspectFiles": [{ "path": "src/...", "reason": "why this file" }],
  "relatedCommits": [{ "sha": "abc1234", "subject": "commit subject" }],
  "steps": [
    {
      "n": 1,
      "title": "short imperative title",
      "detail": "what to change and why",
      "files": ["src/..."],
      "validation": "how to confirm this step worked"
    }
  ],
  "tests": ["test to add or run"],
  "rollback": "how to undo the change safely"
}`;

function buildPrompt(issue, repoContext) {
  return `You are a senior engineer triaging a defect in this repository. You are running inside a
checkout of the repository — read the actual source files and git history before answering.

# Jira issue ${issue.key}
Summary: ${issue.summary}
Status: ${issue.status}   Priority: ${issue.priority}   Labels: ${(issue.labels ?? []).join(', ')}

Description:
${issue.description || '(empty)'}

# Repository context gathered up front
${repoContext}

# Task
1. Locate the code paths this defect most likely lives in. Cite real file paths from this repo.
2. Look at the past commits touching those paths for regressions or related fixes.
3. Produce a concrete step-by-step fix plan an engineer can follow without further investigation.

Answer with a single JSON object and nothing else — no prose, no code fence — matching:
${SCHEMA}

Use 3 to 8 steps. Every path you cite must exist in this repository.`;
}

/** Pulls the first balanced JSON object out of a model response. */
function extractJson(text) {
  // The CLI decorates its output with ANSI colour codes, which are not valid JSON.
  const cleaned = String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*[A-Za-z]/g, '')
    .replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object in the engine response.');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error('Unterminated JSON object in the engine response.');
}

function runCopilotCli(prompt) {
  const bin = env.COPILOT_CLI_BIN || 'copilot';
  const extra = (env.COPILOT_CLI_ARGS ?? '--allow-all-tools').split(' ').filter(Boolean);

  const result = spawnSync(bin, [...extra, '-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: Number(env.COPILOT_TIMEOUT_MS ?? 900_000),
    cwd: env.GITHUB_WORKSPACE || process.cwd(),
    env: { ...process.env, COPILOT_ALLOW_ALL: '1' },
  });

  if (result.error) throw new Error(`Copilot CLI failed to start: ${result.error.message}`);

  if (result.status !== 0) {
    // Echo both streams in full — the thrown message is truncated, and when this
    // failure is the reason for a fallback the detail is what explains it.
    console.error('--- copilot stdout ---');
    console.error(result.stdout || '(empty)');
    console.error('--- copilot stderr ---');
    console.error(result.stderr || '(empty)');
    throw new Error(`Copilot CLI exited ${result.status}: ${(result.stderr || result.stdout || '').slice(-2000)}`);
  }

  return result.stdout;
}

/**
 * Claude reads the context this script gathered rather than browsing the repo itself,
 * so the prompt carries the suspect source inline (see context.mjs).
 */
async function runClaude(prompt) {
  const client = new Anthropic();
  const model = env.ZEROBUG_MODEL || 'claude-opus-5';

  // Streamed because thinking is on by default on Opus 5 and counts against max_tokens;
  // a non-streaming request this size risks an HTTP timeout.
  const stream = client.messages.stream({
    model,
    max_tokens: 32000,
    system: 'You are a senior engineer triaging a defect. You output a single JSON object and nothing else.',
    messages: [{ role: 'user', content: prompt }],
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (error) {
    // Surface what the API actually said — a bare SDK message hides the status and reason.
    const status = error.status ? `HTTP ${error.status}` : 'request failed';
    const detail = error.error?.error?.message ?? error.message;
    throw new Error(`Anthropic API ${status}: ${detail}`);
  }

  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${message.stop_details?.category ?? 'unknown'}).`);
  }

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

const asArray = (value) => (Array.isArray(value) ? value : []);

function normalise(raw, issue, engine) {
  return {
    jiraId: issue.key,
    summary: raw.summary || issue.summary,
    generatedAt: new Date().toISOString(),
    engine,
    riskLevel: ['low', 'medium', 'high'].includes(raw.riskLevel) ? raw.riskLevel : 'medium',
    rootCauseHypothesis: raw.rootCauseHypothesis || 'Not determined.',
    suspectFiles: asArray(raw.suspectFiles)
      .filter((file) => file?.path)
      .map((file) => ({ path: String(file.path), reason: String(file.reason ?? '') })),
    relatedCommits: asArray(raw.relatedCommits)
      .filter((commit) => commit?.sha)
      .map((commit) => ({ sha: String(commit.sha).slice(0, 12), subject: String(commit.subject ?? '') })),
    steps: asArray(raw.steps).map((step, index) => ({
      n: Number(step.n ?? index + 1),
      title: String(step.title ?? `Step ${index + 1}`),
      detail: String(step.detail ?? ''),
      files: asArray(step.files).map(String),
      validation: String(step.validation ?? ''),
    })),
    tests: asArray(raw.tests).map(String),
    rollback: String(raw.rollback ?? 'Revert the fix commit.'),
    jiraUpdated: false,
  };
}

const claudeLabel = () => `anthropic:${env.ZEROBUG_MODEL || 'claude-opus-5'}`;

/**
 * Produces the plan. `copilot` is preferred because that session runs inside the
 * checkout and can open files itself; if it cannot run — no Copilot entitlement,
 * expired token, CLI failure — the Anthropic API takes over.
 *
 * The fallback is never silent: whichever engine produced the plan is recorded in
 * its `engine` field, and a fallback says so.
 */
export async function generatePlan(issue, repoContext, engine = 'copilot') {
  const prompt = buildPrompt(issue, repoContext);

  if (engine === 'claude') {
    console.log(`Engine: Anthropic API (${claudeLabel()})`);
    return normalise(extractJson(await runClaude(prompt)), issue, claudeLabel());
  }

  try {
    console.log('Engine: GitHub Copilot CLI session');
    return normalise(extractJson(runCopilotCli(prompt)), issue, 'copilot-cli');
  } catch (error) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        `Copilot CLI failed and no ANTHROPIC_API_KEY is set to fall back to. ${error.message}`,
      );
    }
    console.warn(`::warning::Copilot CLI unusable, falling back to the Anthropic API. ${error.message}`);
    const plan = normalise(extractJson(await runClaude(prompt)), issue, `${claudeLabel()} (fallback from copilot-cli)`);
    return plan;
  }
}

/** Renders the plan as the Markdown written back into the Jira description. */
export function planToMarkdown(plan) {
  const lines = [
    PLAN_HEADING,
    '',
    `Generated ${plan.generatedAt} by ${plan.engine}. Risk: ${plan.riskLevel}.`,
    '',
    '### Root cause hypothesis',
    plan.rootCauseHypothesis,
    '',
  ];

  if (plan.suspectFiles.length) {
    lines.push('### Suspect files');
    plan.suspectFiles.forEach((file) => lines.push(`- ${file.path} — ${file.reason}`));
    lines.push('');
  }

  if (plan.relatedCommits.length) {
    lines.push('### Related commits');
    plan.relatedCommits.forEach((commit) => lines.push(`- ${commit.sha} ${commit.subject}`));
    lines.push('');
  }

  lines.push('### Step by step fix');
  plan.steps.forEach((step) => {
    lines.push(`${step.n}. ${step.title}`);
    lines.push(`   ${step.detail}`);
    if (step.files.length) lines.push(`   Files: ${step.files.join(', ')}`);
    if (step.validation) lines.push(`   Verify: ${step.validation}`);
  });
  lines.push('');

  if (plan.tests.length) {
    lines.push('### Tests');
    plan.tests.forEach((test) => lines.push(`- ${test}`));
    lines.push('');
  }

  lines.push('### Rollback', plan.rollback);
  return lines.join('\n');
}

/**
 * Appends the plan to the existing description, replacing any block a previous
 * ZeroBug run left behind so the issue never accumulates stale plans.
 */
export function mergeIntoDescription(existingDescription, plan) {
  const original = String(existingDescription ?? '');
  const previous = original.indexOf(PLAN_HEADING);
  const kept = (previous === -1 ? original : original.slice(0, previous)).trimEnd();
  return `${kept}\n\n${planToMarkdown(plan)}\n`.trimStart();
}

export { extractJson, buildPrompt, normalise, PLAN_HEADING, SCHEMA };
