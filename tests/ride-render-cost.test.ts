import { setupDom } from './dom-setup';
const dom = setupDom();
// The map has its own suite; here it would only add frames of its own.
dom.window.localStorage.setItem('cycle-indoors.settings.v1', JSON.stringify({ ftp: 200, showMiniMap: false }));

// The ride clock only moves when told to, so "nothing changed" really means
// nothing changed. Frames and the background timer keep ticking in real time,
// exactly the ticks an idle ride screen gets. Restored at the end: every test
// file shares these globals.
const realNow = performance.now.bind(performance);
let clock = realNow();
performance.now = () => clock;

/** Each graph clears its canvas once per paint; count those per canvas. */
const paints = new Map<string, number>();
const baseContext = dom.window.HTMLCanvasElement.prototype.getContext;
dom.window.HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, ...args: unknown[]) {
  const ctx = (baseContext as (...a: unknown[]) => Record<string, unknown>).apply(this, args);
  const id = this.id;
  ctx.clearRect = () => { paints.set(id, (paints.get(id) ?? 0) + 1); };
  return ctx;
} as never;
const count = (id: string) => paints.get(id) ?? 0;
const reset = () => paints.clear();

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { parseZwo } = await import('../src/workout/zwo');
const { readFileSync } = await import('node:fs');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough for many frames and a background tick, all on a still clock. */
const ticks = () => wait(300);

bootApp();
await wait(300);

session.loadWorkout(parseZwo(
  `<workout_file><name>Costs</name><workout>
     <SteadyState Duration="2" Power="0.6"/>
     <SteadyState Duration="600" Power="0.9"/>
   </workout></workout_file>`,
  { ftp: 200 },
));
courseStore.load(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Costs loop'));
await ticks();

suite('an idle ride screen paints nothing', () => {
  reset();
  for (let i = 0; i < 60; i++) session.advance();
  check('60 idle ticks repaint neither graph', count('profile') === 0 && count('elevation') === 0,
    `profile ${count('profile')}, elevation ${count('elevation')}`);
});

await (async () => {
  reset();
  await ticks();
  suite('an idle ride screen paints nothing between frames either', () => {
    check('a still screen over many frames repaints neither graph', count('profile') === 0 && count('elevation') === 0,
      `profile ${count('profile')}, elevation ${count('elevation')}`);
  });
})();

session.start();
await ticks();
reset();
await ticks();

suite('a running ride paints only what changed', () => {
  check('with the clock still, nothing is repainted', count('profile') === 0 && count('elevation') === 0,
    `profile ${count('profile')}, elevation ${count('elevation')}`);
});

clock += 1000;
await ticks();
const afterSecond = count('profile');
const firstBlock = session.snapshot.segmentIndex;
reset();
clock += 1100;
await ticks();
const afterBlock = count('profile');

suite('a running ride still paints every change', () => {
  check('a new recorded second repaints the workout graph once', afterSecond === 1, String(afterSecond));
  check('the next block repaints it once', session.snapshot.segmentIndex === firstBlock + 1 && afterBlock === 1,
    `block ${firstBlock} → ${session.snapshot.segmentIndex}, ${afterBlock} paints`);
  check('the ride is recording', session.snapshot.samples.length >= 2, String(session.snapshot.samples.length));
});

// Another tab in front of the ride: it keeps riding but paints nothing, and
// the ride screen shown again paints both graphs at once, up to date.
const tab = (name: string) => dom.window.document.querySelector<HTMLButtonElement>(`#tabs button[data-tab="${name}"]`)!.click();
tab('settings');
await ticks();
reset();
const hiddenFrom = session.snapshot.elapsed;
for (let i = 0; i < 3; i++) { clock += 1000; await ticks(); }
const hidden = { profile: count('profile'), elevation: count('elevation'), elapsed: session.snapshot.elapsed - hiddenFrom };
tab('ride');
const shown = { profile: count('profile'), elevation: count('elevation') };

suite('a hidden ride screen paints nothing', () => {
  check('three seconds of riding behind Settings repaint neither graph', hidden.profile === 0 && hidden.elevation === 0,
    `profile ${hidden.profile}, elevation ${hidden.elevation}`);
  check('the ride kept going all the while', Math.abs(hidden.elapsed - 3) < 0.01, `${hidden.elapsed} s`);
  check('back on the ride screen, both graphs paint once straight away', shown.profile === 1 && shown.elevation === 1,
    `profile ${shown.profile}, elevation ${shown.elevation}`);
});

session.pause();
courseStore.unload();
performance.now = realNow;
report();
