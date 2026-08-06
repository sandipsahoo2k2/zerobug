import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { FixPlan } from '../models/plan.model';

/** Prefix that loads the bundled sample plan instead of hitting GitHub. */
export const DEMO_PREFIX = 'DEMO';

/**
 * Serves a sample plan shipped with the app, so the dashboard can be explored
 * without a GitHub token or a workflow run.
 */
@Injectable({ providedIn: 'root' })
export class DemoPlanService {
  private readonly http = inject(HttpClient);

  isDemoId(jiraId: string): boolean {
    return jiraId.toUpperCase().startsWith(DEMO_PREFIX);
  }

  /** Relative URL so it resolves against the Pages base href. */
  load(): Observable<FixPlan> {
    return this.http.get<FixPlan>('demo-plan.json');
  }
}
