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
  jiraUpdated: boolean;
}
