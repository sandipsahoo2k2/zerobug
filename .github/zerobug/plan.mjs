import { spawnSync } from 'node:child_process';

/**
 * Turns a Jira issue + repository context into a step-by-step fix plan.
 * The only engine is a headless GitHub Copilot CLI session running inside the checked-out
 * repo, so it can open files and walk history itself.
 *
 * DELIBERATE: there is no model fallback here, and none should be added.
 * We do not want to use a local/third-party LLM for coding — GitHub Copilot should work.
 * A Copilot failure is a credential or entitlement problem to fix, not something to route
 * around: routing around it silently changes which model writes our code. If you came here
 * to "restore" the Anthropic fallback, fix COPILOT_TOKEN instead.
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
    // Echo both streams in full — the thrown message is truncated, and this detail is
    // the only thing that explains why the run failed.
    console.error('--- copilot stdout ---');
    console.error(result.stdout || '(empty)');
    console.error('--- copilot stderr ---');
    console.error(result.stderr || '(empty)');
    throw new Error(`Copilot CLI exited ${result.status}: ${(result.stderr || result.stdout || '').slice(-2000)}`);
  }

  return result.stdout;
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
    // Filled in from git history after the engine returns — see owners.mjs. Kept when
    // present because this also normalises a plan read back from the plans branch, and
    // that one has already been through owner ranking.
    owners: asArray(raw.owners),
    assignment: raw.assignment ?? null,
    jiraUpdated: Boolean(raw.jiraUpdated),
  };
}

/** Printed on every plan run and again on failure, so the rule is impossible to miss. */
const NO_FALLBACK_NOTICE =
  'We do not want to use a local/third-party LLM for coding — GitHub Copilot should work. ' +
  'There is no model fallback by design; if the Copilot session fails, fix the Copilot ' +
  'credential or entitlement instead of adding one back.';

/**
 * Produces the plan with the Copilot CLI, which runs inside the checkout and can open
 * files itself. If it cannot run — no Copilot entitlement, expired token, CLI failure —
 * the run fails. That is intentional; see NO_FALLBACK_NOTICE and the header comment.
 */
export async function generatePlan(issue, repoContext) {
  const prompt = buildPrompt(issue, repoContext);

  console.log('Engine: GitHub Copilot CLI session (the only engine)');
  console.log(`::notice::${NO_FALLBACK_NOTICE}`);

  try {
    return normalise(extractJson(runCopilotCli(prompt)), issue, 'copilot-cli');
  } catch (error) {
    throw new Error(`Copilot CLI could not produce a plan. ${NO_FALLBACK_NOTICE} ${error.message}`);
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

  if (plan.owners?.length) {
    lines.push('### Who knows this code');
    plan.owners.forEach((owner, index) => {
      const lead = index === 0 ? 'Closest to it' : index === 1 ? 'Also involved' : 'Worth asking';
      lines.push(`- ${lead}: ${owner.name} (${owner.email}) — ${owner.reason}`);
    });
    if (plan.assignment) {
      lines.push('');
      lines.push(
        plan.assignment.assignee
          ? `Assigned to ${plan.assignment.displayName ?? plan.assignment.assignee} (${plan.assignment.via}): ${plan.assignment.why}.`
          : `Left unassigned: ${plan.assignment.why}.`,
      );
      lines.push(
        'Ranked from this repository\'s git history, not from team structure. If the ticket ' +
          'landed on the wrong person, reassign it — the people above are the ones to ask.',
      );
    }
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
