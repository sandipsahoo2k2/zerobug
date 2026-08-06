export interface ZeroBugSettings {
  /** GitHub org/user that owns the repo holding the defect + the workflow. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Workflow file name that runs the Copilot analysis. */
  workflowFile: string;
  /** Git ref the workflow is dispatched on. */
  ref: string;
  /** Branch the workflow commits `plans/<JIRA-ID>.json` to. */
  plansBranch: string;
  /**
   * Fine-grained PAT, this repo only, `actions:write` + `contents:read`.
   * Kept in localStorage — it is your own token in your own browser, never sent anywhere
   * except api.github.com.
   */
  token: string;
}

export const DEFAULT_SETTINGS: ZeroBugSettings = {
  owner: 'sandipsahoo2k2',
  repo: 'zerobug',
  workflowFile: 'zerobug-plan.yml',
  ref: 'main',
  plansBranch: 'zerobug-plans',
  token: '',
};
