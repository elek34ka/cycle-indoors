import { setupDom } from './dom-setup';
setupDom();

const { check, near, report, until } = await import('./harness');

/** `suite` for async bodies: the harness's own does not wait for them. */
async function suite(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  await body();
}
const { Course } = await import('../src/activity/course');
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { session } = await import('../src/session/session');
const { openRouteScene, openRouteSceneView, MESSAGES, sceneProblem } = await import('../src/ui/route-scene-view');
const { NoWebGLError } = await import('../src/scene/render/types');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses, drawnAt } = await import('../src/scene/passes');
const { elevationPlot, xForDistance } = await import('../src/ui/elevation-graph');
const { readFileSync } = await import('node:fs');
const { trackFromLocal, eastbound } = await import('./scene-fixtures');
import type { FrameView, RendererLoader, SceneModel, SceneRenderer } from '../src/scene/render/types';
import type { Piece } from '../src/scene/chunks';
import type { ActivityTrack } from '../src/activity/types';

/** A renderer that draws nothing and remembers what it was asked. */
class FakeRenderer implements SceneRenderer {
  static live = 0;
  static created = 0;
  static disposed = 0;
  readonly canvas = document.createElement('canvas');
  resolutions: number[] = [];
  exaggerations: number[] = [];
  built: Piece[] = [];
  frames: FrameView[] = [];
  lost: (() => void)[] = [];
  isDisposed = false;
  constructor(readonly model: SceneModel, readonly exaggeration: number) { FakeRenderer.live++; FakeRenderer.created++; }
  setResolution(w: number) { this.resolutions.push(w); }
  setExaggeration(e: number) { this.exaggerations.push(e); }
  build(piece: Piece) { this.built.push(piece); }
  drop() {}
  clear() {}
  render(view: FrameView) { this.frames.push(view); }
  onContextLost(listener: () => void) { this.lost.push(listener); }
  dispose() { if (!this.isDisposed) { this.isDisposed = true; FakeRenderer.live--; FakeRenderer.disposed++; } }
}

let lastFake: FakeRenderer | undefined;
const fakeLoader: RendererLoader = async () => (model, ex) => (lastFake = new FakeRenderer(model, ex));

/** Frames run only when the test says so. */
const pending = new Map<number, (t: number) => void>();
let nextHandle = 1;
let clock = 0;
const requestFrame = (cb: (t: number) => void) => { const h = nextHandle++; pending.set(h, cb); return h; };
const cancelFrame = (h: number) => { pending.delete(h); };
function tick(ms = 1000 / 60, count = 1): void {
  for (let n = 0; n < count; n++) {
    clock += ms;
    const due = [...pending.values()];
    pending.clear();
    for (const cb of due) cb(clock);
  }
}

const sample = () => parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample loop');
const open = (track: ActivityTrack = sample(), loadRenderer: RendererLoader = fakeLoader) =>
  openRouteScene({ track, name: track.name, loadRenderer, requestFrame, cancelFrame });
const ready = () => until(() => lastFake !== undefined && !lastFake.isDisposed && pending.size > 0, (v) => v);
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';
const readout = (label: string) => {
  for (const r of document.querySelectorAll('.scene-readout')) {
    if (r.querySelector('.scene-readout-label')?.textContent === label) return r.querySelector('.scene-readout-value')?.textContent ?? '';
  }
  return '';
};
const choice = (group: string, value: string) => q<HTMLButtonElement>(`.scene-choice[data-group="${group}"][data-value="${value}"]`)!;

// ---- a ride in progress, which the preview must leave alone ----
const rideCourse = courseStore.load(sample());
session.start();
const before = { course: courseStore.current, distance: session.snapshot.distance, target: session.snapshot.targetPower, state: session.snapshot.state };

await suite('3D view: opening and closing leave the ride alone', async () => {
  lastFake = undefined;
  const view = open();
  check('the window opens over the app', q('.scene-dialog') !== null && q('.scene-card[role="dialog"]')?.getAttribute('aria-label') === 'Route 3D preview');
  check('it says it is loading until the renderer arrives', text('.scene-message') === MESSAGES.loading);
  await ready();
  check('the renderer\'s canvas is in the window', q('.scene-stage canvas') === lastFake!.canvas);
  check('the road under the rider is built straight away', lastFake!.built.length >= 1 && lastFake!.built[0].kind === 'chunk');
  tick(16, 5);
  check('frames are drawn', lastFake!.frames.length === 5, `${lastFake!.frames.length}`);
  view.close();
  check('Close removes the window', q('.scene-dialog') === null && openRouteSceneView() === undefined);
  check('and frees the renderer', lastFake!.isDisposed);
  check('no frame is left scheduled', pending.size === 0);

  open();
  await ready();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes it too', q('.scene-dialog') === null && lastFake!.isDisposed);

  check('the ride\'s course is the same object', courseStore.current === before.course && courseStore.current === rideCourse);
  check('the ride is still running', session.snapshot.state === before.state);
  check('the trainer target is unchanged', session.snapshot.targetPower === before.target);
});

await suite('3D view: first person', async () => {
  const view = open();
  await ready();
  check('no camera choice is offered', q('.scene-choice[data-group="camera"]') === null);
  for (const d of [0, 5000, 12000]) {
    view.jumpTo(d);
    tick();
    const f = lastFake!.frames.at(-1)!;
    near(`at ${d / 1000} km the eye sits 1.5 m above the drawn road at the rider`, f.camera.position[1] - f.rider[1], 1.5, 1e-9);
    near('… right over the rider', Math.hypot(f.camera.position[0] - f.rider[0], f.camera.position[2] - f.rider[2]), 0, 1e-9);
    check('… looking ahead, not at the rider', Math.hypot(f.camera.target[0] - f.rider[0], f.camera.target[2] - f.rider[2]) > 10);
    check('the renderer is told nothing about a rider body', !('showRider' in f) && !('riderQuaternion' in f));
  }
  view.close();
});

await suite('3D view: jumping and readouts', async () => {
  const track = sample();
  const course = new Course(track);
  const view = open(track);
  await ready();
  const canvas = q<HTMLCanvasElement>('.scene-profile')!;
  // the stub box is 320 px wide; the canvas draws at its own 640
  const plot = elevationPlot({ width: canvas.width, height: canvas.height });
  const clientX = xForDistance(15400, plot, course.totalDistance) * (320 / canvas.width);
  canvas.dispatchEvent(new window.MouseEvent('click', { clientX, bubbles: true }));
  check('a click on the profile at 15.4 km puts the rider there', readout('Distance') === `15.4 / ${(course.totalDistance / 1000).toFixed(1)} km`, readout('Distance'));
  tick();
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const want = drawnAt(g, p, 15400);
  const got = lastFake!.frames.at(-1)!.rider;
  near('the next frame is drawn there', Math.hypot(got[0] - want.x, got[2] - want.z), 0, 2);
  const at = course.at(15400);
  check('the gradient readout is the ride\'s own', readout('Gradient') === `${at.gradient.toFixed(1)}%`, `${readout('Gradient')} vs ${at.gradient.toFixed(1)}%`);
  check('and so is the elevation', readout('Elevation') === `${Math.round(at.ele)} m`, readout('Elevation'));
  view.close();
});

await suite('3D view: the climb banner', async () => {
  // 1 km flat, 2 km at 7%, 1 km flat
  const track = trackFromLocal(eastbound(4000, (d) => (d < 1000 ? 100 : d < 3000 ? 100 + (d - 1000) * 0.07 : 240)), 'Seven per cent');
  const view = open(track);
  await ready();
  check('no banner on the flat', q('.scene-banner')!.hidden);
  view.jumpTo(1600);
  check('600 m into the climb the banner shows', !q('.scene-banner')!.hidden);
  check('7%', text('.scene-banner-grade') === '7%', text('.scene-banner-grade'));
  check('and 1.4 km to the top', text('.scene-banner-left') === '1.4 km to the top', text('.scene-banner-left'));
  view.close();
});

await suite('3D view: playback and a hidden tab', async () => {
  const view = open();
  await ready();
  q<HTMLButtonElement>('.scene-play')!.click();
  check('Play starts playback', text('.scene-play') === 'Pause');
  tick(1000 / 60, 120);
  // from a standstill 2 s covers only metres, so the speed readout tells
  check('the rider moves', readout('Speed') !== '0.0 km/h', readout('Speed'));
  const framesBefore = lastFake!.frames.length;
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  check('hiding the tab pauses playback', text('.scene-play') === 'Play');
  check('and stops frames', pending.size === 0);
  tick(16, 10);
  check('nothing is drawn while hidden', lastFake!.frames.length === framesBefore);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  check('showing it again resumes drawing', pending.size === 1);
  check('but not playback', text('.scene-play') === 'Play');
  view.close();
});

await suite('3D view: settings', async () => {
  const view = open();
  await ready();
  check('Medium (640 px) by default', lastFake!.resolutions.at(-1) === 640 && choice('resolution', 'medium').getAttribute('aria-pressed') === 'true');
  choice('resolution', 'chunky').click();
  check('Chunky asks the renderer for 480 px', lastFake!.resolutions.at(-1) === 480);
  choice('resolution', 'fine').click();
  check('Fine for 960 px', lastFake!.resolutions.at(-1) === 960);
  check('heights start at 2.5×', lastFake!.exaggeration === 2.5);
  const slider = q<HTMLInputElement>('.scene-exaggeration')!;
  slider.value = '1';
  slider.dispatchEvent(new window.Event('change'));
  check('1× is passed to the renderer', lastFake!.exaggerations.at(-1) === 1);
  tick();
  const f = lastFake!.frames.at(-1)!;
  // at 1× a height is drawn at its real size above the route's lowest point
  near('at 1× the rider is drawn at true height', f.rider[1], (drawnHeightAtStart() - lastFake!.model.ground.base), 1e-6);
  view.close();
});

function drawnHeightAtStart(): number {
  const course = new Course(sample());
  const g = buildGeometry(course);
  return drawnAt(g, buildPasses(g, buildViewProfile(course, g)), 0).h;
}

await suite('3D view: ten opens and closes', async () => {
  const createdBefore = FakeRenderer.created;
  const disposedBefore = FakeRenderer.disposed;
  let most = 0;
  for (let n = 0; n < 10; n++) {
    const view = open();
    await ready();
    most = Math.max(most, FakeRenderer.live);
    tick();
    view.close();
  }
  check('ten renderers were made', FakeRenderer.created - createdBefore === 10);
  check('and all ten disposed', FakeRenderer.disposed - disposedBefore === 10);
  check('never more than one alive at once', most === 1 && FakeRenderer.live === 0, `most ${most}, now ${FakeRenderer.live}`);
  // opening another while one is open replaces it
  open();
  await ready();
  const first = lastFake!;
  open();
  await ready();
  check('opening a second view closes the first', first.isDisposed && document.querySelectorAll('.scene-dialog').length === 1);
  openRouteSceneView()?.close();
});

await suite('3D view: when 3D cannot be shown', async () => {
  const failing: RendererLoader = () => Promise.reject(new Error('chunk failed'));
  open(sample(), failing);
  await until(() => text('.scene-message'), (t) => t === MESSAGES.loadFailed);
  check('a failed load says so', text('.scene-message') === MESSAGES.loadFailed);
  q<HTMLButtonElement>('.scene-close')!.click();
  check('and Close still closes', q('.scene-dialog') === null);

  const noWebgl: RendererLoader = async () => () => { throw new NoWebGLError(); };
  open(sample(), noWebgl);
  await until(() => text('.scene-message'), (t) => t === MESSAGES.noWebgl);
  check('no WebGL says so', text('.scene-message') === MESSAGES.noWebgl);
  q<HTMLButtonElement>('.scene-close')!.click();
  check('and Close closes', q('.scene-dialog') === null);

  const view = open();
  await ready();
  lastFake!.lost.forEach((l) => l());
  check('a lost context says so', text('.scene-message') === MESSAGES.contextLost && !q('.scene-message')!.hidden);
  check('and stops drawing', pending.size === 0);
  view.close();
});

await suite('3D view: a route without elevation', async () => {
  const flat = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8').replace(/<ele>[^<]*<\/ele>/g, ''), 'No heights');
  check('the fixture really has no elevation', !flat.hasElevation);
  const view = open(flat);
  await ready();
  check('it opens', q('.scene-dialog') !== null);
  check('drawn flat', lastFake!.model.p.ph.every((h) => h === 0));
  check('with no elevation value', readout('Elevation') === '—' && readout('Gradient') === '—', `${readout('Elevation')}, ${readout('Gradient')}`);
  view.close();
  const point = trackFromLocal([{ x: 0, z: 0, ele: 100 }]);
  check('a file with one GPS point is not a route', sceneProblem(point) !== undefined);
  let threw = false;
  try { open(point); } catch { threw = true; }
  check('and the window refuses it', threw && q('.scene-dialog') === null);
});

session.finish();
check('the ride\'s course was never replaced', courseStore.current === rideCourse);
report();
