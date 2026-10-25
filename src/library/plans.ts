import type { PlanEntry } from '../catalog/types';

export interface PlanProgress {
  /** plan workouts marked done */
  done: number;
  total: number;
  /** the first workout id, in plan order, not marked done */
  next: string | undefined;
  complete: boolean;
}

/**
 * Where a rider stands in a plan. Derived from the done marks every time,
 * never stored, so a republished plan (workouts added, removed, reordered)
 * is always measured against its current list. Marks for ids the plan no
 * longer has count for nothing.
 */
export function planProgress(plan: PlanEntry, isDone: (workoutId: string) => boolean): PlanProgress {
  let done = 0;
  let next: string | undefined;
  for (const id of plan.workouts) {
    if (isDone(id)) done++;
    else next ??= id;
  }
  const total = plan.workouts.length;
  return { done, total, next, complete: total > 0 && done === total };
}
