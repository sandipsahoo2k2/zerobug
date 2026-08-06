import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FixPlan } from '../../core/models/plan.model';

/** Renders one generated fix plan. Pure presentation — no data fetching. */
@Component({
  selector: 'app-plan-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plan-view.html',
  styleUrl: './plan-view.css',
})
export class PlanView {
  readonly plan = input.required<FixPlan>();
}
