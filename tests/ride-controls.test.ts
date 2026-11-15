import { setupDom } from './dom-setup';
const dom = setupDom();
dom.window.localStorage.setItem('cycle-indoors.settings.v1', JSON.stringify({ ftp: 220, useMockDevices: true }));

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { mock } = await import('../src/devices/setup');
const { session } = await import('../src/session/session');
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { parseZwo } = await import('../src/workout/zwo');
const { readFileSync } = await import('node:fs');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One frame renders, and the 500 ms trainer throttle has let the command out. */
const settle = () => wait(650);

bootApp();
await wait(1800);

const tileByLabel = (label: string) => Array.from(doc.querySelectorAll<HTMLElement>('#metrics .tile'))
  .find((t) => t.querySelector('.tile-label')?.textContent === label);
const target = () => {
  const t = tileByLabel('Target');
  const rows = Array.from(t?.querySelectorAll<HTMLElement>('.tile-side .tile-sub') ?? [])
    .filter((r) => r.style.display !== 'none').map((r) => r.textContent ?? '');
  return { value: t?.querySelector('.tile-value > span')?.textContent ?? '', sub: rows.join(' | '), rows };
};
const groupOf = (label: string) => Array.from(doc.querySelectorAll<HTMLElement>('#controls .group'))
  .find((g) => g.querySelector('label')?.textContent === label)!;
const blockWatts = () => doc.querySelector<HTMLInputElement>('#controls input[data-role="block-watts"]')!;
const freeWatts = () => doc.querySelector<HTMLInputElement>('#controls input[data-role="free-watts"]')!;
const biasButtons = () => Array.from(groupOf('Bias').querySelectorAll<HTMLButtonElement>('button'));
const shown = (node: HTMLElement | null | undefined) => {
  for (let n = node; n; n = n.parentElement) if (n.style.display === 'none') return false;
  return Boolean(node);
};
const type = (input: HTMLInputElement, text: string) => {
  input.focus();
  input.value = text;
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};
const freeButton = (kind: 'grade' | 'power') =>
  doc.querySelector<HTMLButtonElement>(`#controls button[data-free-target="${kind}"]`)!;

session.loadWorkout(parseZwo(
  `<workout_file><name>Controls</name><workout>
     <SteadyState Duration="120" Power="1.0" Cadence="90"/>
     <SteadyState Duration="120" Power="0.5"/>
     <FreeRide Duration="120" Cadence="85"/>
   </workout></workout_file>`,
  { ftp: 220 },
));
session.start();
await settle();

type(blockWatts(), '250');
blockWatts().blur();
await settle();

suite('entering 250 W', () => {
  check('the Target tile reads 250', target().value === '250', target().value);
  check('with no delta, bias or override tag', target().sub === '90 rpm', target().sub);
  check('the trainer holds 250 W', mock.rig.mode === 'erg' && mock.rig.targetPower === 250, String(mock.rig.targetPower));
  check('the field shows 250', blockWatts().value === '250', blockWatts().value);
  check('the bias buttons are disabled', biasButtons().length === 2 && biasButtons().every((b) => b.disabled));
  const bias = session.snapshot.ergBias;
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  check('↑ does not change bias', session.snapshot.ergBias === bias);
});

type(blockWatts(), '5000');
await settle();

suite('a refused value', () => {
  check('the field puts back the target in force', blockWatts().value === '250', blockWatts().value);
  check('and the trainer keeps 250 W', mock.rig.targetPower === 250, String(mock.rig.targetPower));
});

session.finish();
report();
