import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SettingsService } from '../../core/services/settings.service';
import { ZeroBugService } from '../../core/services/zerobug.service';
import { PlanView } from '../plan-view/plan-view';
import { SettingsPanel } from '../settings-panel/settings-panel';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  dispatching: 'Dispatching workflow',
  queued: 'Run queued',
  running: 'Copilot session running',
  'fetching-plan': 'Fetching plan',
  done: 'Done',
  error: 'Failed',
};

/** Entry screen: take a Jira ID, run the analysis, show the plan, push it back to Jira. */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PlanView, SettingsPanel],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard {
  private readonly zeroBug = inject(ZeroBugService);
  private readonly settingsService = inject(SettingsService);

  readonly jiraIdInput = signal('');
  readonly phase = this.zeroBug.phase;
  readonly run = this.zeroBug.run;
  readonly plan = this.zeroBug.plan;
  readonly error = this.zeroBug.error;
  readonly log = this.zeroBug.log;
  readonly busy = this.zeroBug.busy;
  readonly canPublish = this.zeroBug.canPublish;
  readonly isConfigured = this.settingsService.isConfigured;

  readonly phaseLabel = computed(() => PHASE_LABEL[this.phase()] ?? this.phase());
  readonly canStart = computed(
    () => this.isConfigured() && !this.busy() && this.jiraIdInput().trim().length > 0,
  );

  onJiraIdInput(event: Event): void {
    this.jiraIdInput.set((event.target as HTMLInputElement).value);
  }

  start(): void {
    if (!this.canStart()) return;
    void this.zeroBug.startAnalysis(this.jiraIdInput());
  }

  loadExisting(): void {
    if (this.busy() || !this.jiraIdInput().trim()) return;
    void this.zeroBug.loadExistingPlan(this.jiraIdInput());
  }

  publish(): void {
    if (!this.canPublish()) return;
    void this.zeroBug.publishToJira();
  }
}
