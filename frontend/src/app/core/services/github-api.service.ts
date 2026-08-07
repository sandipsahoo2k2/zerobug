import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { FixPlan } from '../models/plan.model';
import { PullRequest, WorkflowRun, WorkflowRunList } from '../models/run.model';
import { SettingsService } from './settings.service';

const API = 'https://api.github.com';

/**
 * Thin wrapper over the GitHub REST API.
 * api.github.com sends `Access-Control-Allow-Origin: *`, so the static GitHub Page
 * can call it directly — no server of our own.
 */
@Injectable({ providedIn: 'root' })
export class GithubApiService {
  private readonly http = inject(HttpClient);
  private readonly settingsService = inject(SettingsService);

  /** Fires the workflow. GitHub answers 204 with no body — the run is found by polling. */
  dispatchWorkflow(jiraId: string, mode: 'plan' | 'publish'): Observable<void> {
    const { owner, repo, workflowFile, ref } = this.settingsService.settings();
    return this.http.post<void>(
      `${API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
      { ref, inputs: { jira_id: jiraId, mode } },
      { headers: this.headers() },
    );
  }

  /** Recent dispatched runs of the ZeroBug workflow, newest first. */
  listRuns(): Observable<WorkflowRunList> {
    const { owner, repo, workflowFile } = this.settingsService.settings();
    return this.http.get<WorkflowRunList>(
      `${API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=20`,
      { headers: this.headers() },
    );
  }

  getRun(runId: number): Observable<WorkflowRun> {
    const { owner, repo } = this.settingsService.settings();
    return this.http.get<WorkflowRun>(`${API}/repos/${owner}/${repo}/actions/runs/${runId}`, {
      headers: this.headers(),
    });
  }

  /** Open pull requests — the coding agent delivers its plan as one. */
  listPullRequests(): Observable<PullRequest[]> {
    const { owner, repo } = this.settingsService.settings();
    return this.http.get<PullRequest[]>(
      `${API}/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=created&direction=desc`,
      { headers: this.headers() },
    );
  }

  /** Reads `plans/<JIRA-ID>.json` from a branch as raw text. Defaults to the plans branch. */
  getPlan(jiraId: string, ref?: string): Observable<FixPlan> {
    const { owner, repo, plansBranch } = this.settingsService.settings();
    const url =
      `${API}/repos/${owner}/${repo}/contents/plans/${jiraId}.json` +
      `?ref=${encodeURIComponent(ref ?? plansBranch)}&cacheBust=${Date.now()}`;
    return this.http
      .get(url, { headers: this.headers('application/vnd.github.raw+json'), responseType: 'text' })
      .pipe(map((body) => JSON.parse(body) as FixPlan));
  }

  private headers(accept = 'application/vnd.github+json'): HttpHeaders {
    const { token } = this.settingsService.settings();
    let headers = new HttpHeaders({
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    });
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  }
}
