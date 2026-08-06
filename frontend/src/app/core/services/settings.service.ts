import { Injectable, computed, effect, signal } from '@angular/core';
import { DEFAULT_SETTINGS, ZeroBugSettings } from '../models/settings.model';

const STORAGE_KEY = 'zerobug.settings';

/** Owns dashboard configuration and persists it to localStorage. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly state = signal<ZeroBugSettings>(this.load());

  readonly settings = this.state.asReadonly();
  readonly isConfigured = computed(() => {
    const s = this.state();
    return Boolean(s.owner && s.repo && s.workflowFile && s.token);
  });

  constructor() {
    effect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state())));
  }

  update(patch: Partial<ZeroBugSettings>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }

  clearToken(): void {
    this.update({ token: '' });
  }

  private load(): ZeroBugSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
}
