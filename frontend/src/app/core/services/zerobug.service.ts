import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FixPlan } from '../models/plan.model';
import { JobPhase, WorkflowRun } from '../models/run.model';
import { GithubApiService } from './github-api.service';

const POLL_INTERVAL_MS = 4_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
/** The plans branch needs a moment to show the new commit after the run turns green. */
const PLAN_FETCH_ATTEMPTS = 8;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives one ZeroBug job: dispatch the workflow, follow the run, read the plan it commits.
 * All compute happens in GitHub Actions — this service only talks to the GitHub REST API.
 */
@Injectable({ providedIn: 'root' })
export class ZeroBugService {
  private readonly github = inject(GithubApiService);

  private readonly phaseState = signal<JobPhase>('idle');
  private readonly runState = signal<WorkflowRun | null>(null);
  private readonly planState = signal<FixPlan | null>(null);
  private readonly errorState = signal<string | null>(null);
  private readonly logState = signal<string[]>([]);
  private readonly jiraIdState = signal('');

  readonly phase = this.phaseState.asReadonly();
  readonly run = this.runState.asReadonly();
  readonly plan = this.planState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly log = this.logState.asReadonly();
  readonly jiraId = this.jiraIdState.asReadonly();

  readonly busy = computed(() => !['idle', 'done', 'error'].includes(this.phaseState()));
  readonly canPublish = computed(() => this.phaseState() === 'done' && this.planState() !== null);

  /** Runs the Copilot analysis for a Jira issue and loads the resulting plan. */
  async startAnalysis(rawJiraId: string): Promise<void> {
    const jiraId = normalize(rawJiraId);
    if (!jiraId) {
      this.fail('Enter a Jira ID, e.g. ZB-123.');
      return;
    }

    this.reset(jiraId);
    await this.runJob(jiraId, 'plan', 'Analysing defect with the Copilot session…');
  }

  /** Re-runs the workflow in publish mode: writes the stored plan into the Jira description. */
  async publishToJira(): Promise<void> {
    const jiraId = this.jiraIdState();
    if (!jiraId) return;

    this.errorState.set(null);
    await this.runJob(jiraId, 'publish', 'Writing the plan into the Jira description…');
  }

  /** Loads a previously generated plan without running the workflow again. */
  async loadExistingPlan(rawJiraId: string): Promise<void> {
    const jiraId = normalize(rawJiraId);
    if (!jiraId) return;

    this.reset(jiraId);
    this.phaseState.set('fetching-plan');
    this.append(`Looking for an existing plan for ${jiraId}…`);
    try {
      this.planState.set(await firstValueFrom(this.github.getPlan(jiraId)));
      this.phaseState.set('done');
      this.append('Plan loaded.');
    } catch {
      this.fail(`No stored plan for ${jiraId}. Run the analysis first.`);
    }
  }

  private async runJob(jiraId: string, mode: 'plan' | 'publish', startMessage: string): Promise<void> {
    this.phaseState.set('dispatching');
    this.append(startMessage);

    const dispatchedAt = Date.now() - 60_000;
    try {
      await firstValueFrom(this.github.dispatchWorkflow(jiraId, mode));
      this.append(`Workflow dispatched (mode: ${mode}).`);
    } catch (error) {
      this.fail(`Could not dispatch the workflow. ${describe(error)}`);
      return;
    }

    const run = await this.awaitRun(jiraId, dispatchedAt);
    if (!run) return;

    if (run.conclusion !== 'success') {
      this.fail(`Run finished with conclusion "${run.conclusion}". See the run log on GitHub.`);
      return;
    }

    this.phaseState.set('fetching-plan');
    this.append('Run succeeded. Fetching the plan…');
    const plan = await this.fetchPlanWithRetry(jiraId);
    if (!plan) {
      this.fail('Run succeeded but plans/' + jiraId + '.json was not found on the plans branch.');
      return;
    }

    this.planState.set(plan);
    this.phaseState.set('done');
    this.append(plan.jiraUpdated ? 'Plan ready. Jira description updated.' : 'Plan ready.');
  }

  /** Polls the workflow runs until the one matching this Jira ID completes. */
  private async awaitRun(jiraId: string, dispatchedAt: number): Promise<WorkflowRun | null> {
    this.phaseState.set('queued');
    const deadline = Date.now() + RUN_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const { workflow_runs } = await firstValueFrom(this.github.listRuns());
        const match = workflow_runs.find(
          (candidate) =>
            candidate.name?.includes(jiraId) && Date.parse(candidate.created_at) >= dispatchedAt,
        );
        if (!match) continue;

        this.runState.set(match);
        if (match.status === 'completed') {
          return match;
        }
        if (this.phaseState() !== 'running' && match.status === 'in_progress') {
          this.phaseState.set('running');
          this.append('Runner is analysing the repository…');
        }
      } catch (error) {
        this.fail(`Lost track of the run. ${describe(error)}`);
        return null;
      }
    }

    this.fail('Timed out waiting for the workflow run.');
    return null;
  }

  private async fetchPlanWithRetry(jiraId: string): Promise<FixPlan | null> {
    for (let attempt = 0; attempt < PLAN_FETCH_ATTEMPTS; attempt++) {
      try {
        return await firstValueFrom(this.github.getPlan(jiraId));
      } catch {
        await sleep(3_000);
      }
    }
    return null;
  }

  private reset(jiraId: string): void {
    this.jiraIdState.set(jiraId);
    this.planState.set(null);
    this.runState.set(null);
    this.errorState.set(null);
    this.logState.set([]);
  }

  private append(message: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.logState.update((lines) => [...lines, `${stamp}  ${message}`]);
  }

  private fail(message: string): void {
    this.errorState.set(message);
    this.phaseState.set('error');
    this.append(`Error: ${message}`);
  }
}

const normalize = (value: string): string => value.trim().toUpperCase();

const describe = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: number }).status;
    if (status === 401 || status === 403) return 'Token rejected — check scopes (actions:write).';
    if (status === 404) return 'Workflow or repository not found — check the settings.';
    return `HTTP ${status}.`;
  }
  return String(error);
};
