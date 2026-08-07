import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SettingsService } from './core/services/settings.service';
import { SettingsPanel } from './features/settings-panel/settings-panel';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, SettingsPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly settingsService = inject(SettingsService);

  /** Opens on first load until a token is present, so the dashboard is never a dead end. */
  readonly settingsOpen = signal(!this.settingsService.isConfigured());
  readonly isConfigured = this.settingsService.isConfigured;

  openSettings(): void {
    this.settingsOpen.set(true);
  }

  closeSettings(): void {
    this.settingsOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeSettings();
  }
}
