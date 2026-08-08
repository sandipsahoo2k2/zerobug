/** Shape of `plans/<JIRA-ID>.json`, produced by the ZeroBug GitHub Actions workflow. */
export interface FixStep {
  n: number;
  title: string;
  detail: string;
  files: string[];
  validation: string;
}

export interface SuspectFile {
  path: string;
  reason: string;
}

export interface RelatedCommit {
  sha: string;
  subject: string;
}

/** Someone the git history says knows this code. Ranked by blame share and recency. */
export interface Owner {
  name: string;
  email: string;
  score: number;
  blameShare: number;
  commits: number;
  lastTouched: string | null;
  stale: boolean;
  files: string[];
  reason: string;
}

/** Who the ticket went to, and why that was the answer. */
export interface Assignment {
  assignee: string | null;
  via: 'blame' | 'default' | 'unassigned' | string;
  why: string;
  displayName?: string;
  applied?: boolean;
  error?: string;
}

export interface FixPlan {
  jiraId: string;
  summary: string;
  generatedAt: string;
  engine: string;
  riskLevel: 'low' | 'medium' | 'high' | string;
  rootCauseHypothesis: string;
  suspectFiles: SuspectFile[];
  relatedCommits: RelatedCommit[];
  steps: FixStep[];
  tests: string[];
  rollback: string;
  owners?: Owner[];
  assignment?: Assignment | null;
  jiraUpdated: boolean;
}
