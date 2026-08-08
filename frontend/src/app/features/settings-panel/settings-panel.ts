import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { SettingsService } from '../../core/services/settings.service';

/** Repo/workflow coordinates plus the GitHub token used to dispatch runs. */
@Component({
  selector: 'app-settings-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-panel.html',
  styleUrl: './settings-panel.css',
})
export class SettingsPanel {
  private readonly settingsService = inject(SettingsService);

  readonly close = output<void>();

  readonly settings = this.settingsService.settings;
  readonly isConfigured = this.settingsService.isConfigured;

  set(
    field: 'owner' | 'repo' | 'workflowFile' | 'ref' | 'plansBranch' | 'defaultAssignee' | 'token',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement).value;
    this.settingsService.update({ [field]: value });
  }

  clearToken(): void {
    this.settingsService.clearToken();
  }
}
