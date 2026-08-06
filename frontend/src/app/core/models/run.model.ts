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

export type JobPhase =
  | 'idle'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'fetching-plan'
  | 'done'
  | 'error';
