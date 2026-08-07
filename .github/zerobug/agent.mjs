/**
 * Starts a GitHub Copilot coding agent session.
 *
 * The agent cannot be invoked directly: you give it a GitHub issue and assign that issue
 * to the `copilot-swe-agent` actor. The session then shows up in the repository's Agents
 * tab, runs on GitHub's infrastructure, and opens a pull request when it is done.
 */

const API = 'https://api.github.com';

const COPILOT_LOGIN = 'copilot-swe-agent';

async function rest(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub REST ${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function graphql(query, variables, token) {
  const response = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}

/**
 * Preflight: is the coding agent actually assignable in this repository?
 * Returns the actor id, or null when the account has no entitlement or the repo has the
 * agent disabled — which is the difference worth reporting clearly.
 */
export async function findCopilotAgent(owner, repo, token) {
  const data = await graphql(
    `query ($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
          nodes { login __typename ... on Bot { id } ... on User { id } }
        }
      }
    }`,
    { owner, repo },
    token,
  );

  const actors = data?.repository?.suggestedActors?.nodes ?? [];
  const agent = actors.find((actor) => actor.login === COPILOT_LOGIN);
  if (!agent) {
    console.log(`Assignable actors: ${actors.map((a) => a.login).join(', ') || '(none)'}`);
  }
  return agent ?? null;
}

/** The brief the agent works from. */
export function buildAgentBrief(jiraId, issue, repoContext, schema) {
  return `Jira ${jiraId} reports a defect in this repository. Investigate it and commit a fix plan.

## The defect
**${issue.summary}**

Status: ${issue.status}   Priority: ${issue.priority}   Labels: ${(issue.labels ?? []).join(', ')}

${issue.description || '(no description)'}

## What to do
1. Read the code and the git history around this defect. Find where it actually lives.
2. Do **not** fix the code. Produce a plan an engineer can follow.
3. Write your plan to \`plans/${jiraId}.json\` — that file is the only change in your pull request.

The file must be a single JSON object in exactly this shape:

\`\`\`json
${schema}
\`\`\`

Use 3 to 8 steps. Every file path you cite must exist in this repository. Title the pull
request \`ZeroBug plan for ${jiraId}\` so the dashboard can find it.

## Context gathered before this session started
${repoContext}`;
}

/** Creates the tracking issue the agent will pick up. */
export async function createIssue(owner, repo, token, { title, body }) {
  return rest(`/repos/${owner}/${repo}/issues`, token, {
    method: 'POST',
    body: JSON.stringify({ title, body }),
  });
}

/** Assigning the issue to the agent is what actually starts the session. */
export async function assignToAgent(issueNodeId, agentId, token) {
  await graphql(
    `mutation ($assignableId: ID!, $actorIds: [ID!]!) {
      replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
        assignable { ... on Issue { number } }
      }
    }`,
    { assignableId: issueNodeId, actorIds: [agentId] },
    token,
  );
}
