import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (args, fallback = '') => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch {
    return fallback;
  }
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'when', 'error', 'issue', 'bug', 'defect', 'fails', 'failing',
  'not', 'from', 'that', 'this', 'after', 'before', 'user', 'page', 'should', 'does', 'while',
  'expected', 'actual', 'steps', 'reproduce', 'instead', 'exactly', 'same', 'thing', 'happens',
  'also', 'reported', 'being', 'which', 'rules', 'still', 'used', 'work', 'works', 'started',
  'somewhere', 'last', 'releases', 'gets', 'getting', 'valid', 'until', 'goes', 'checkout',
]);

/** Words from the issue worth grepping for: identifiers, CamelCase, dotted paths. */
function keywords(text, limit = 8) {
  const tokens = String(text ?? '').match(/[A-Za-z_][A-Za-z0-9_.$-]{3,}/g) ?? [];
  const seen = new Map();
  for (const rawToken of tokens) {
    // Sentence punctuation glues onto words ("valid." / "work.") — grepping that finds nothing.
    const token = rawToken.replace(/[.\-_$]+$/, '');
    if (token.length < 4) continue;
    const key = token.toLowerCase();
    if (STOP_WORDS.has(key)) continue;
    const interesting = /[A-Z]/.test(token.slice(1)) || token.includes('.') || token.includes('_');
    seen.set(token, (seen.get(token) ?? 0) + (interesting ? 3 : 1));
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

/** Generated files drown out real signal in both hotspots and grep. */
const EXCLUDED = [
  ':!**/package-lock.json',
  ':!**/yarn.lock',
  ':!**/pnpm-lock.yaml',
  ':!**/node_modules/**',
  ':!**/dist/**',
  ':!**/*.min.*',
  ':!**/*.map',
];

/** Files touched most often lately — a cheap hotspot signal. */
function hotspots(limit = 15) {
  const raw = git(['log', '-n', '150', '--name-only', '--pretty=format:', '--', '.', ...EXCLUDED]);
  const counts = new Map();
  for (const line of raw.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, count]) => `${count.toString().padStart(3)}  ${file}`);
}

function grepHits(terms, perTerm = 12) {
  const blocks = [];
  const files = new Map();

  for (const term of terms) {
    const hits = git(['grep', '-n', '-I', '-i', '-e', term, '--', '.', ...EXCLUDED]);
    if (!hits) continue;

    const lines = hits.split('\n');
    for (const line of lines) {
      const path = line.split(':')[0];
      if (path) files.set(path, (files.get(path) ?? 0) + 1);
    }
    blocks.push(`### matches for "${term}"\n${lines.slice(0, perTerm).join('\n')}`);
  }

  const ranked = [...files.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
  return { text: blocks.join('\n\n'), files: ranked };
}

/**
 * Full source of the files the search points at. An engine running inside the
 * checkout could open these itself; one reached over an API cannot, so the
 * context carries them inline.
 */
function fileSources(paths, limit = 4, maxBytes = 24_000) {
  const blocks = [];
  for (const path of paths.slice(0, limit)) {
    try {
      const source = readFileSync(path, 'utf8');
      const clipped = source.length > maxBytes ? `${source.slice(0, maxBytes)}\n… (truncated)` : source;
      blocks.push(`### ${path}\n\`\`\`\n${clipped}\n\`\`\``);
    } catch {
      // Binary, deleted, or unreadable — the grep excerpt above still stands on its own.
    }
  }
  return blocks.join('\n\n');
}

/**
 * Builds the repository context handed to the Copilot session: history, commits that
 * already mention this Jira ID, hotspots and grep hits for issue keywords.
 */
export function buildRepoContext(jiraId, issue) {
  const terms = keywords(`${issue.summary} ${issue.description}`);
  const hits = grepHits(terms);
  return [
    `## Repository\n${git(['config', '--get', 'remote.origin.url'], 'unknown remote')}`,
    `Current branch: ${git(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown')}`,
    `\n## Top level\n${git(['ls-tree', '--name-only', 'HEAD'])}`,
    `\n## Last 25 commits\n${git(['log', '-n', '25', '--pretty=format:%h %ad %an %s', '--date=short'])}`,
    `\n## Commits already mentioning ${jiraId}\n${
      git(['log', '--all', '-n', '20', '--pretty=format:%h %ad %s', '--date=short', `--grep=${jiraId}`, '-i']) ||
      '(none)'
    }`,
    `\n## Change hotspots (last 150 commits)\n${hotspots().join('\n')}`,
    `\n## Keyword search\nkeywords: ${terms.join(', ') || '(none extracted)'}\n${
      hits.text || '(no matches)'
    }`,
    `\n## Source of the files the search points at\n${
      fileSources(hits.files) || '(nothing to show)'
    }`,
  ].join('\n');
}

export { keywords };
