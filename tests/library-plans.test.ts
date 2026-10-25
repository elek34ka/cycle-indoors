const { planProgress } = await import('../src/library/plans');
const { check, report, suite } = await import('./harness');

const plan = {
  id: 'plan:P', path: 'P', title: 'P',
  workouts: ['workout:plans/P/1', 'workout:plans/P/2', 'workout:plans/P/3', 'workout:plans/P/4', 'workout:plans/P/5'],
  totals: { workouts: 5, duration: 0, tss: 0 },
};
const doneOf = (...n: number[]) => (id: string) => n.some((i) => id === `workout:plans/P/${i}`);

suite('plan progress', () => {
  const none = planProgress(plan, doneOf());
  check('none done: 0 of 5, next is the first', none.done === 0 && none.total === 5 && none.next === 'workout:plans/P/1' && !none.complete);
  const two = planProgress(plan, doneOf(1, 2));
  check('first two done: next is the third', two.done === 2 && two.next === 'workout:plans/P/3');
  const skipped = planProgress(plan, doneOf(1, 2, 5));
  check('skipping ahead: the fifth counts, next is still the third', skipped.done === 3 && skipped.next === 'workout:plans/P/3');
  const all = planProgress(plan, doneOf(1, 2, 3, 4, 5));
  check('all done: complete, no next', all.complete && all.next === undefined && all.done === 5);
  const stale = planProgress(plan, (id) => id === 'workout:plans/P/gone' || id === 'workout:plans/P/1');
  check('a mark for a workout no longer in the plan counts for nothing', stale.done === 1 && stale.next === 'workout:plans/P/2');
  const empty = planProgress({ ...plan, workouts: [] }, doneOf());
  check('an empty plan is not "complete"', !empty.complete && empty.next === undefined);
});

report();
