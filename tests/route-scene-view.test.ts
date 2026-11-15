import { setupDom } from './dom-setup';
setupDom();

const { check, report, until } = await import('./harness');

/** `suite` for async bodies: the harness's own does not wait for them. */
async function suite(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  await body();
}
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { session } = await import('../src/session/session');
const { openRouteScene, openRouteSceneView, MESSAGES } = await import('../src/ui/route-scene-view');
const { NoWebGLError } = await import('../src/scene/render/types');
const { readFileSync } = await import('node:fs');
import type { FrameView, RendererLoader, SceneModel, SceneRenderer } from '../src/scene/render/types';
import type { Piece } from '../src/scene/chunks';
import type { Season } from '../src/scene/palette';
import type { ActivityTrack } from '../src/activity/types';

/** A renderer that draws nothing and remembers what it was asked. */
class FakeRenderer implements SceneRenderer {
  static live = 0;
  static created = 0;
  static disposed = 0;
  readonly canvas = document.createElement('canvas');
  resolutions: number[] = [];
  exaggerations: number[] = [];
  seasons: Season[] = [];
  built: Piece[] = [];
  frames: FrameView[] = [];
  lost: (() => void)[] = [];
  isDisposed = false;
  constructor(readonly model: SceneModel, readonly exaggeration: number) { FakeRenderer.live++; FakeRenderer.created++; }
  setResolution(w: number) { this.resolutions.push(w); }
  setExaggeration(e: number) { this.exaggerations.push(e); }
  setSeason(s: Season) { this.seasons.push(s); }
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

session.finish();
check('the ride\'s course was never replaced', courseStore.current === rideCourse);
report();
