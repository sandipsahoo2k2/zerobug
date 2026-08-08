import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Works out who knows the code a defect lives in, from the repository's own history.
 *
 * Two signals, combined: how much of each suspect file a person actually wrote
 * (blame), and how recently they have worked on it (log). Neither alone is enough —
 * blame credits whoever last reformatted a line, and commit counts credit someone who
 * touched the file once a year ago.
 */

const HALF_LIFE_DAYS = 180;
/** Past this, someone has almost certainly moved on — still listed, never auto-assigned. */
const STALE_DAYS = 365;
const DAY_MS = 86_400_000;

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
};

/**
 * `users.noreply.github.com` is the privacy address of a real person and must not be
 * filtered; bare `noreply@github.com` is what automation commits as.
 */
const isBot = (name = '', email = '') => {
  if (/\[bot\]$/i.test(name)) return true;
  if (/^(dependabot|renovate|github-actions|copilot-swe-agent|zerobug)\b/i.test(name)) return true;
  if (/users\.noreply\.github\.com$/i.test(email)) return false;
  return /^noreply@github\.com$/i.test(email) || /\bbot@/i.test(email);
};

/** Recent work counts for more than old work, without a hard cutoff. */
const recencyWeight = (timestampMs) =>
  Math.pow(0.5, (Date.now() - timestampMs) / (HALF_LIFE_DAYS * DAY_MS));

/**
 * `-w` ignores whitespace-only changes and `-C` follows code moved between files —
 * without both, blame credits reformatting rather than authorship.
 */
function blameLines(path) {
  const raw = git(['blame', '-w', '-C', '--line-porcelain', '--', path]);
  const counts = new Map();
  let total = 0;
  let author = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('author ')) author = { name: line.slice(7) };
    else if (line.startsWith('author-mail ') && author) {
      author.email = line.slice(12).replace(/[<>]/g, '');
      const key = author.email.toLowerCase();
      if (!isBot(author.name, author.email)) {
        const entry = counts.get(key) ?? { name: author.name, email: author.email, lines: 0 };
        entry.lines += 1;
        counts.set(key, entry);
      }
      total += 1;
      author = null;
    }
  }

  return { counts, total };
}

function commitHistory(path) {
  const raw = git(['log', '--follow', '--pretty=format:%an%x1f%ae%x1f%at%x1f%s', '--', path]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, email, at, subject] = line.split('\x1f');
      return { name, email, at: Number(at) * 1000, subject };
    })
    .filter((commit) => commit.email && !isBot(commit.name, commit.email));
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const agoText = (timestampMs) => {
  const days = Math.floor((Date.now() - timestampMs) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${plural(days, 'day')} ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${plural(months, 'month')} ago` : `${Math.round(months / 12)} years ago`;
};

/**
 * Ranks the people who know the suspect files best.
 * Returns at most `limit` candidates, each with a one-line justification.
 */
export function rankOwners(suspectFiles, limit = 3) {
  const paths = [...new Set(suspectFiles.map((file) => file.path ?? file).filter(Boolean))];
  const people = new Map();

  const upsert = (email, name) => {
    const key = email.toLowerCase();
    if (!people.has(key)) {
      people.set(key, {
        name,
        email,
        blameScore: 0,
        commits: 0,
        recency: 0,
        lastTouched: 0,
        files: new Set(),
        topShare: 0,
      });
    }
    return people.get(key);
  };

  for (const path of paths) {
    if (!existsSync(path)) continue;

    const { counts, total } = blameLines(path);
    for (const entry of counts.values()) {
      const person = upsert(entry.email, entry.name);
      const share = total ? entry.lines / total : 0;
      person.blameScore += share;
      person.topShare = Math.max(person.topShare, share);
      person.files.add(path);
    }

    for (const commit of commitHistory(path)) {
      const person = upsert(commit.email, commit.name);
      person.commits += 1;
      person.recency += recencyWeight(commit.at);
      person.lastTouched = Math.max(person.lastTouched, commit.at);
      person.files.add(path);
    }
  }

  return [...people.values()]
    .map((person) => {
      const staleDays = person.lastTouched ? (Date.now() - person.lastTouched) / DAY_MS : Infinity;
      return {
        name: person.name,
        email: person.email,
        score: Number((person.blameScore * 3 + person.recency).toFixed(3)),
        blameShare: Number(person.topShare.toFixed(2)),
        commits: person.commits,
        lastTouched: person.lastTouched ? new Date(person.lastTouched).toISOString() : null,
        stale: staleDays > STALE_DAYS,
        files: [...person.files],
        reason: buildReason(person, staleDays),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildReason(person, staleDays) {
  const parts = [];
  if (person.topShare > 0) {
    parts.push(`wrote ${Math.round(person.topShare * 100)}% of ${shortest(person.files)}`);
  }
  if (person.commits > 0) {
    parts.push(`${plural(person.commits, 'commit')} touching these files`);
  }
  if (person.lastTouched) {
    parts.push(`last active ${agoText(person.lastTouched)}`);
  }
  const summary = parts.join(', ') || 'appears in the history of these files';
  return staleDays > STALE_DAYS ? `${summary} — likely moved on, listed for context only` : summary;
}

const shortest = (files) => [...files].sort((a, b) => a.length - b.length)[0] ?? 'the suspect files';

/** Optional git-email → Jira accountId map, checked into the repo. */
export function loadOwnerMap(path = new URL('./owners.json', import.meta.url).pathname) {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Object.fromEntries(
      Object.entries(raw)
        // Skip the documentation key and any address left without an account ID.
        .filter(([email, id]) => !email.startsWith('_') && typeof id === 'string' && id.trim())
        .map(([email, id]) => [email.toLowerCase(), id.trim()]),
    );
  } catch {
    return {};
  }
}

/**
 * Picks who the ticket goes to. Falls back to the configured default whenever the
 * history does not give a clear answer — a tie, a stale top candidate, or a git
 * identity with no Jira account mapped to it. Guessing an accountId is never an option.
 */
export function resolveAssignee(owners, { defaultAssignee, ownerMap = {} } = {}) {
  const fallback = (why) =>
    defaultAssignee
      ? { assignee: defaultAssignee, via: 'default', why }
      : { assignee: null, via: 'unassigned', why: `${why}, and no default assignee is configured` };

  const [first, second] = owners;
  if (!first) return fallback('the history names nobody for these files');
  if (second && first.score === second.score) {
    return fallback(`${first.name} and ${second.name} rank equally`);
  }
  if (first.stale) return fallback(`the top candidate ${first.name} has not touched this code in over a year`);

  const accountId = ownerMap[first.email.toLowerCase()];
  if (!accountId) {
    return fallback(`${first.name} <${first.email}> has no Jira account in owners.json`);
  }

  return {
    assignee: accountId,
    via: 'blame',
    why: `${first.name} ranks highest: ${first.reason}`,
    owner: first,
  };
}
