import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Jira access with two interchangeable backends:
 *   1. a Jira MCP server launched over stdio (JIRA_MCP_COMMAND) — preferred,
 *   2. the Jira Cloud REST API (JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN) — fallback.
 * Both run inside the Actions runner, so credentials stay in Actions secrets.
 */

const env = process.env;

const mcpConfigured = () => Boolean(env.JIRA_MCP_COMMAND);
const restConfigured = () =>
  Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);

/* ------------------------------------------------------------------ MCP ---- */

async function withMcp(fn) {
  const transport = new StdioClientTransport({
    command: env.JIRA_MCP_COMMAND,
    args: (env.JIRA_MCP_ARGS ?? '').split(',').map((a) => a.trim()).filter(Boolean),
    env: { ...process.env },
  });
  const client = new Client({ name: 'zerobug', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return await fn(client, tools);
  } finally {
    await client.close().catch(() => {});
  }
}

/** MCP servers name their Jira tools differently; match on intent instead of exact names. */
const pickTool = (tools, patterns) =>
  tools.find((tool) => patterns.every((pattern) => pattern.test(tool.name)));

/** Maps a value onto whichever argument name this particular server expects. */
const argFor = (tool, pattern, value, fallbackName) => {
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const name = props.find((prop) => pattern.test(prop)) ?? fallbackName;
  return { [name]: value };
};

const textOf = (result) =>
  (result?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

/* ----------------------------------------------------------------- REST ---- */

const restHeaders = () => ({
  Authorization: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

async function restRequest(path, init = {}) {
  const response = await fetch(`${env.JIRA_BASE_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: restHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Jira REST ${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

/** Flattens Atlassian Document Format into plain text. */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const inner = adfToText(node.content);
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

/** Minimal Markdown -> ADF: headings, bullets, everything else a paragraph. */
function textToAdf(text) {
  const content = [];
  let bullets = null;

  const flush = () => {
    if (bullets) {
      content.push({ type: 'bulletList', content: bullets });
      bullets = null;
    }
  };

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);

    if (heading) {
      flush();
      content.push({
        type: 'heading',
        attrs: { level: Math.min(heading[1].length + 1, 6) },
        content: [{ type: 'text', text: heading[2] }],
      });
    } else if (bullet) {
      bullets ??= [];
      bullets.push({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: bullet[1] }] }],
      });
    } else if (line.trim() === '') {
      flush();
    } else {
      flush();
      content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
    }
  }
  flush();

  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph' }] };
}

/* ------------------------------------------------------------------ API ---- */

/** Reads an issue and normalises it to { key, summary, description, status, priority, labels }. */
export async function readIssue(jiraId) {
  if (mcpConfigured()) {
    return withMcp(async (client, tools) => {
      const tool = pickTool(tools, [/issue/i, /get|read|fetch|detail/i]);
      if (!tool) throw new Error(`No issue-read tool in MCP server. Saw: ${tools.map((t) => t.name).join(', ')}`);

      const result = await client.callTool({
        name: tool.name,
        arguments: argFor(tool, /issue_?(key|id)|issueIdOrKey|^key$/i, jiraId, 'issue_key'),
      });
      const raw = textOf(result);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { key: jiraId, summary: jiraId, description: raw, status: '', priority: '', labels: [], source: `mcp:${tool.name}` };
      }
      const fields = parsed.fields ?? parsed;
      return {
        key: parsed.key ?? jiraId,
        summary: fields.summary ?? parsed.summary ?? jiraId,
        description: typeof fields.description === 'string' ? fields.description : adfToText(fields.description),
        status: fields.status?.name ?? parsed.status ?? '',
        priority: fields.priority?.name ?? '',
        labels: fields.labels ?? [],
        source: `mcp:${tool.name}`,
      };
    });
  }

  if (restConfigured()) {
    const data = await restRequest(
      `/rest/api/3/issue/${encodeURIComponent(jiraId)}?fields=summary,description,status,priority,labels`,
    );
    return {
      key: data.key,
      summary: data.fields.summary ?? '',
      description: adfToText(data.fields.description),
      status: data.fields.status?.name ?? '',
      priority: data.fields.priority?.name ?? '',
      labels: data.fields.labels ?? [],
      source: 'rest',
    };
  }

  throw new Error('Jira is not configured. Set JIRA_MCP_COMMAND, or JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN.');
}

/** Replaces the issue description with the generated plan. */
export async function updateDescription(jiraId, markdown) {
  if (mcpConfigured()) {
    return withMcp(async (client, tools) => {
      const tool = pickTool(tools, [/issue/i, /update|edit|modify/i]);
      if (!tool) throw new Error(`No issue-update tool in MCP server. Saw: ${tools.map((t) => t.name).join(', ')}`);

      const props = Object.keys(tool.inputSchema?.properties ?? {});
      const args = argFor(tool, /issue_?(key|id)|issueIdOrKey|^key$/i, jiraId, 'issue_key');

      if (props.some((prop) => /^description$/i.test(prop))) {
        args.description = markdown;
      } else if (props.some((prop) => /^fields$/i.test(prop))) {
        args.fields = { description: markdown };
      } else {
        args[props.find((prop) => /body|content|text/i.test(prop)) ?? 'description'] = markdown;
      }

      await client.callTool({ name: tool.name, arguments: args });
      return `mcp:${tool.name}`;
    });
  }

  if (restConfigured()) {
    await restRequest(`/rest/api/3/issue/${encodeURIComponent(jiraId)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { description: textToAdf(markdown) } }),
    });
    return 'rest';
  }

  throw new Error('Jira is not configured for writing.');
}

export { adfToText, textToAdf };
