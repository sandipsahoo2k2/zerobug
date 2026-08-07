/** Subset of the GitHub Actions workflow-run payload the dashboard cares about. */
export interface WorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: 'success' | 'failure' | 'cancelled' | null;
  html_url: string;
  created_at: string;
}

export interface WorkflowRunList {
  workflow_runs: WorkflowRun[];
}

/** Pull request opened by the Copilot coding agent, carrying the plan file. */
export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string };
}

export type JobPhase =
  | 'idle'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'fetching-plan'
  | 'done'
  | 'error';
