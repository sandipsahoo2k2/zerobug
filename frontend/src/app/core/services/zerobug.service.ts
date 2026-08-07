import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FixPlan } from '../models/plan.model';
import { JobPhase, PullRequest, WorkflowRun } from '../models/run.model';
import { GithubApiService } from './github-api.service';
import { SettingsService } from './settings.service';

const POLL_INTERVAL_MS = 4_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
/**
 * With the coding agent the workflow run finishes in seconds and the session keeps working
 * afterwards, so the plan hunt has to outlive the run by a long way.
 */
const PLAN_HUNT_TIMEOUT_MS = 25 * 60_000;
const PLAN_HUNT_INTERVAL_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives one ZeroBug job: dispatch the workflow, follow the run, read the plan it commits.
 * All compute happens in GitHub Actions — this service only talks to the GitHub REST API.
 */
@Injectable({ providedIn: 'root' })
export class ZeroBugService {
  private readonly github = inject(GithubApiService);
  private readonly settingsService = inject(SettingsService);

  private readonly phaseState = signal<JobPhase>('idle');
  private readonly runState = signal<WorkflowRun | null>(null);
  private readonly planState = signal<FixPlan | null>(null);
  private readonly errorState = signal<string | null>(null);
  private readonly logState = signal<string[]>([]);
  private readonly jiraIdState = signal('');
  private readonly agentPrState = signal<PullRequest | null>(null);

  readonly phase = this.phaseState.asReadonly();
  readonly run = this.runState.asReadonly();
  readonly plan = this.planState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly log = this.logState.asReadonly();
  readonly jiraId = this.jiraIdState.asReadonly();
  readonly agentPr = this.agentPrState.asReadonly();

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
    this.append('Run succeeded. Waiting for the plan…');
    const plan = await this.huntForPlan(jiraId);
    if (!plan) {
      this.fail(
        `Gave up waiting for plans/${jiraId}.json. Check the Copilot session in the repository's ` +
          'Agents tab — if it opened a pull request, the plan file may be named differently.',
      );
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

  /**
   * The plan can arrive by two routes: committed to the plans branch by the CLI engine, or
   * added by the coding agent on the branch behind its pull request. Watch both.
   */
  private async huntForPlan(jiraId: string): Promise<FixPlan | null> {
    const deadline = Date.now() + PLAN_HUNT_TIMEOUT_MS;
    let announcedPr = false;

    while (Date.now() < deadline) {
      const { plansBranch, ref } = this.settingsService.settings();

      for (const branch of [plansBranch, ref]) {
        const plan = await this.tryPlan(jiraId, branch);
        if (plan) return plan;
      }

      const pr = await this.findAgentPullRequest(jiraId);
      if (pr) {
        this.agentPrState.set(pr);
        if (!announcedPr) {
          announcedPr = true;
          this.append(`Agent opened pull request #${pr.number}. Reading the plan from it…`);
        }
        const plan = await this.tryPlan(jiraId, pr.head.ref);
        if (plan) return plan;
      }

      await sleep(PLAN_HUNT_INTERVAL_MS);
    }
    return null;
  }

  private async tryPlan(jiraId: string, ref: string): Promise<FixPlan | null> {
    try {
      return await firstValueFrom(this.github.getPlan(jiraId, ref));
    } catch {
      return null;
    }
  }

  private async findAgentPullRequest(jiraId: string): Promise<PullRequest | null> {
    try {
      const pulls = await firstValueFrom(this.github.listPullRequests());
      return (
        pulls.find((pull) => `${pull.title} ${pull.body ?? ''}`.toUpperCase().includes(jiraId)) ??
        null
      );
    } catch {
      return null;
    }
  }

  private reset(jiraId: string): void {
    this.jiraIdState.set(jiraId);
    this.planState.set(null);
    this.runState.set(null);
    this.agentPrState.set(null);
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
