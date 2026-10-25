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

suite('the ERG block watts field', () => {
  check('it sits in the Bias group', groupOf('Bias').contains(blockWatts()));
  check('it is shown in ERG', shown(blockWatts()));
  check('it starts empty, following the workout', blockWatts().value === '', blockWatts().value);
  check('its placeholder is the workout target', blockWatts().placeholder === '220', blockWatts().placeholder);
  check('the bias buttons are enabled', biasButtons().every((b) => !b.disabled));
  check('the Target tile shows the block\'s cadence target alone', target().sub === '90 rpm', target().sub);
});

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

blockWatts().focus();
blockWatts().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await settle();

suite('Escape clears it', () => {
  check('the target is the workout\'s again', target().value === '220', target().value);
  check('the field is empty', blockWatts().value === '');
  check('the bias buttons are back', biasButtons().every((b) => !b.disabled));
});

type(blockWatts(), '260');
blockWatts().blur();
await settle();
session.skipToNextBlock();
await settle();

suite('the next block empties the field', () => {
  check('the second block\'s target applies', target().value === '110', target().value);
  check('a block with no cadence target leaves the right column empty', target().rows.length === 0, target().sub);
  check('the field is empty again', blockWatts().value === '', blockWatts().value);
  check('with the new target as its placeholder', blockWatts().placeholder === '110', blockWatts().placeholder);
});

session.skipToNextBlock();
await settle();

suite('a FreeRide block, Grade', () => {
  check('the Bias group is hidden', !shown(groupOf('Bias')));
  check('the Grade/Watts choice is shown', shown(freeButton('grade')) && shown(freeButton('power')));
  check('Grade is chosen', freeButton('grade').classList.contains('on') && !freeButton('power').classList.contains('on'));
  check('the slider is shown', shown(doc.querySelector<HTMLElement>('#controls input[type="range"]')));
  check('the watts field is hidden', !shown(freeWatts()));
  check('the Target tile reads —', target().value === '—', target().value);
  check('with the gradient over the cadence target',
    target().rows.length === 2 && /^-?\d+\.\d%$/.test(target().rows[0]) && target().rows[1] === '85 rpm', target().sub);
  const bold = Array.from(tileByLabel('Target')?.querySelectorAll('.tile-side b') ?? []).map((b) => b.textContent ?? '');
  check('the gradient and the cadence number are bold, "rpm" is not',
    bold.length === 2 && /^-?\d+\.\d%$/.test(bold[0]) && bold[1] === '85', bold.join(' , '));
  check('the trainer emulates a gradient', mock.rig.mode === 'sim', mock.rig.mode);
});

freeButton('power').click();
await settle();

suite('a FreeRide block, Watts', () => {
  check('Watts is chosen', freeButton('power').classList.contains('on'));
  check('the watts field is shown with 60 % of FTP', shown(freeWatts()) && freeWatts().value === '130', freeWatts().value);
  check('the slider is hidden', !shown(doc.querySelector<HTMLElement>('#controls input[type="range"]')));
  check('the Target tile reads 130', target().value === '130', target().value);
  check('the trainer holds 130 W', mock.rig.mode === 'erg' && mock.rig.targetPower === 130, `${mock.rig.mode} ${mock.rig.targetPower}`);
});

type(freeWatts(), '180');
freeWatts().blur();
await settle();

suite('typing free watts', () => {
  check('the Target tile reads 180', target().value === '180', target().value);
  check('with only the cadence target beside it', target().sub === '85 rpm', target().sub);
  check('the trainer holds 180 W', mock.rig.targetPower === 180, String(mock.rig.targetPower));
});

session.loadWorkout(undefined);
session.start();
await settle();

suite('an open ride, Watts', () => {
  check('the choice is offered with no workout', shown(freeButton('power')) && freeButton('power').classList.contains('on'));
  check('the trainer holds 180 W', mock.rig.mode === 'erg' && mock.rig.targetPower === 180, String(mock.rig.targetPower));
  check('the Target tile reads 180', target().value === '180', target().value);
});

const track = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
courseStore.load(track);
freeButton('grade').click();
await settle();

suite('an open ride, Grade, with a route', () => {
  const follow = doc.querySelector<HTMLInputElement>('#controls .check input')!;
  check('Follow route is offered and ticked', shown(follow) && follow.checked);
  check('the Target tile reads —', target().value === '—', target().value);
  check('with the route gradient, unlabelled', /^-?\d+\.\d%$/.test(target().sub)
    && Math.abs(parseFloat(target().sub) - (session.snapshot.coursePosition?.gradient ?? 99)) < 0.06, target().sub);
  check('and no cadence target, as an open ride has none', target().rows.length === 1);
  check('the trainer emulates the route', mock.rig.mode === 'sim'
    && Math.abs(mock.rig.grade - (session.snapshot.coursePosition?.gradient ?? 99)) < 0.5,
    `${mock.rig.grade} vs ${session.snapshot.coursePosition?.gradient}`);
});

session.finish();
report();
