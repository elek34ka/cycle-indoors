import { setupDom } from './dom-setup';
const dom = setupDom();

const { MiniMap, clampToViewport } = await import('../src/ui/mini-map');
const { Course } = await import('../src/activity/course');
const { settings } = await import('../src/core/settings');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const doc = dom.window.document;
const host = doc.createElement('div');
doc.body.append(host);

const course = new Course(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample'));
const start = course.points[0];
const halfway = course.at(course.totalDistance / 2);

const map = new MiniMap(host);
await wait(120);

suite('with no route there is no map at all', () => {
  check('the map is not available', map.available === false);
  check('the panel is hidden', host.querySelector('.mini-map')?.classList.contains('hidden') === true);
  check('and so is the button that would bring it back',
    host.querySelector('.mini-map-show')?.classList.contains('hidden') === true);
  check('Leaflet was never even loaded', map.viewState === undefined);
  map.setVisible(true);
  check('asking for it anyway does nothing',
    host.querySelector('.mini-map')?.classList.contains('hidden') === true);
  check('Leaflet is still not loaded', map.viewState === undefined);
});

map.setCourse(course);
await wait(150); // Leaflet is loaded on demand, now that there is something to show

suite('loading a route brings the map up, following and zoomed in', () => {
  check('the map is available', map.available === true);
  check('the panel is shown', host.querySelector('.mini-map')?.classList.contains('hidden') === false);
  check('the map initialised', map.viewState !== undefined);
  check('follow is on by default', settings.current.miniMapFollow === true);
  check('and the switch reflects it',
    host.querySelector<HTMLInputElement>('.map-switch input')?.checked === true);
  check('the switch sits inside the map, not the header',
    host.querySelector('.leaflet-control-container .map-switch') !== null);
  check('there is no dark-basemap picker', host.querySelector('.leaflet-control-layers') === null);
  const view = map.viewState!;
  near('centred on the start latitude', view.lat, start.lat, 0.01);
  near('centred on the start longitude', view.lon, start.lon, 0.01);
  check('zoomed in close enough to see the road', view.zoom >= 16, String(view.zoom));
  check('the route name is shown', host.querySelector('.mini-map-title')?.textContent === course.name,
    host.querySelector('.mini-map-title')?.textContent ?? 'none');
});

map.setRider(halfway.lat, halfway.lon);
await wait(120);

suite('a big jump snaps rather than gliding across the map', () => {
  const view = map.viewState!;
  near('the marker is exactly on the rider', view.rider!.lat, halfway.lat, 0.00001);
  near('and the map went straight there', view.lat, halfway.lat, 0.0005);
  near('in both axes', view.lon, halfway.lon, 0.0005);
  check('still zoomed in', view.zoom >= 16, String(view.zoom));
});

// A second of riding at 30 km/h, fed one position per animation frame, exactly
// as the ride loop does it. The map must not lurch on every update.
const before = map.viewState!;
const centres = new Set<string>();
let walked = course.totalDistance / 2;
for (let i = 0; i < 60; i++) {
  walked += 8.3 / 60; // 30 km/h, one frame's worth
  const point = course.at(walked);
  map.setRider(point.lat, point.lon);
  await wait(16);
  const view = map.viewState!;
  centres.add(`${view.lat.toFixed(6)},${view.lon.toFixed(6)}`);
}
const afterRiding = map.viewState!;

suite('riding normally does not move the map at all', () => {
  check('the map held still through 60 position updates', centres.size === 1,
    `${centres.size} distinct centres`);
  near('the centre is where it was', afterRiding.lat, before.lat, 0.000001);
  check('but the marker did move', (afterRiding.rider?.lat ?? 0) !== (before.rider?.lat ?? 0));
  check('the marker stayed on the course, behind the target by less than a metre',
    Math.abs((afterRiding.rider?.lat ?? 0) - course.at(walked).lat) < 0.0001,
    `${afterRiding.rider?.lat} vs ${course.at(walked).lat}`);
});

// Drift far enough from the middle and it should catch up — smoothly, but it
// must catch up.
const ahead = course.at(walked + 90);
map.setRider(ahead.lat, ahead.lon);
await wait(1600);

suite('drifting out of the dead zone brings the map across', () => {
  const view = map.viewState!;
  near('the map caught up with the rider', view.lat, ahead.lat, 0.002);
  near('in both axes', view.lon, ahead.lon, 0.002);
  check('it moved from where it was', Math.abs(view.lat - before.lat) > 0.0001);
});

map.showWholeRoute();
await wait(20);

suite('the overview button zooms out and stops following', () => {
  const view = map.viewState!;
  check('following switched off', view.following === false);
  check('the switch updated too',
    host.querySelector<HTMLInputElement>('.map-switch input')?.checked === false);
  check('it zoomed out to take in the route', view.zoom < 16, String(view.zoom));
  check('the preference was remembered', settings.current.miniMapFollow === false);
});

const parked = map.viewState!;
map.setRider(start.lat, start.lon);

suite('with following off, the map stays where you left it', () => {
  const view = map.viewState!;
  near('the centre did not move', view.lat, parked.lat, 0.0001);
  near('nor the longitude', view.lon, parked.lon, 0.0001);
  near('nor the zoom', view.zoom, parked.zoom, 0.0001);
});

const input = host.querySelector<HTMLInputElement>('.map-switch input')!;
input.checked = true;
input.dispatchEvent(new dom.window.Event('change'));
await wait(20);

suite('turning the switch back on resumes following', () => {
  const view = map.viewState!;
  check('following is on again', view.following === true);
  check('the preference was remembered', settings.current.miniMapFollow === true);
  near('and it jumped back to the rider', view.lat, start.lat, 0.001);
  check('at close zoom once more', view.zoom >= 16, String(view.zoom));
});

suite('clearing the route takes the map away again', () => {
  map.setCourse(undefined);
  check('the map is no longer available', map.available === false);
  check('the panel is hidden', host.querySelector('.mini-map')?.classList.contains('hidden') === true);
  check('and the button to restore it is hidden too',
    host.querySelector('.mini-map-show')?.classList.contains('hidden') === true);
  check('the title went back to "No route"',
    host.querySelector('.mini-map-title')?.textContent === 'No route');
  check('the route line was removed', host.querySelector('.leaflet-overlay-pane path') === null);
  map.setCourse(course);
  check('and loading a route brings it back',
    host.querySelector('.mini-map')?.classList.contains('hidden') === false);
});

suite('hiding and showing the map', () => {
  map.setVisible(false);
  check('the panel is hidden', host.querySelector('.mini-map')?.classList.contains('hidden') === true);
  check('a button to bring it back is shown',
    host.querySelector('.mini-map-show')?.classList.contains('hidden') === false);
  check('the preference was remembered', settings.current.showMiniMap === false);
  map.setVisible(true);
  check('and it comes back', host.querySelector('.mini-map')?.classList.contains('hidden') === false);
  check('the preference was remembered again', settings.current.showMiniMap === true);
});

suite('the panel is kept inside the window', () => {
  const size = { width: 268, height: 217 };
  const viewport = { width: 1024, height: 768 };
  const at = (left: number, top: number) => JSON.stringify(clampToViewport({ left, top }, size, viewport));
  check('past the left edge', at(-50, 100) === JSON.stringify({ left: 0, top: 100 }), at(-50, 100));
  check('past the right edge', at(900, 100) === JSON.stringify({ left: 756, top: 100 }), at(900, 100));
  check('past the top edge', at(100, -20) === JSON.stringify({ left: 100, top: 0 }), at(100, -20));
  check('past the bottom edge', at(100, 700) === JSON.stringify({ left: 100, top: 551 }), at(100, 700));
  check('inside, it is left alone', at(300, 200) === JSON.stringify({ left: 300, top: 200 }), at(300, 200));
  const huge = JSON.stringify(clampToViewport({ left: 40, top: 40 }, { width: 2000, height: 1000 }, viewport));
  check('a panel bigger than the window pins to the top-left', huge === JSON.stringify({ left: 0, top: 0 }), huge);
});

// jsdom has no layout: the panel reports its inline position once floating,
// and the top-right corner of the graph before that.
const panel = host.querySelector<HTMLElement>('.mini-map')!;
const head = host.querySelector<HTMLElement>('.mini-map-head')!;
panel.getBoundingClientRect = () => {
  const floating = panel.classList.contains('floating');
  const left = floating ? parseFloat(panel.style.left) : 690;
  const top = floating ? parseFloat(panel.style.top) : 60;
  return { left, top, x: left, y: top, width: 268, height: 217, right: left + 268, bottom: top + 217, toJSON: () => ({}) } as DOMRect;
};
const pointer = (target: Element, type: string, clientX: number, clientY: number) =>
  target.dispatchEvent(new dom.window.PointerEvent(type, { clientX, clientY, button: 0, bubbles: true }));
let positionSaves = 0;
settings.on('change', (v) => { if (v.miniMapPosition) positionSaves++; });

suite('the map is dragged by its title bar', () => {
  check('it starts in its corner, not floating', !panel.classList.contains('floating'));
  check('with nothing remembered', settings.current.miniMapPosition === null);
  check('the map itself is outside the title bar, so dragging it still pans the map',
    !head.contains(host.querySelector('.mini-map-canvas')));
  pointer(head, 'pointerdown', 700, 70);
  pointer(head, 'pointermove', 550, 170);
  pointer(head, 'pointermove', 400, 270);
  check('it floats while dragged', panel.classList.contains('floating'));
  check('it moved 300 px left and 200 px down', panel.style.left === '390px' && panel.style.top === '260px',
    `${panel.style.left}, ${panel.style.top}`);
  check('nothing is saved mid-drag', positionSaves === 0, String(positionSaves));
  pointer(head, 'pointerup', 400, 270);
  check('the position is saved once on release', positionSaves === 1, String(positionSaves));
  check('as where it was left', JSON.stringify(settings.current.miniMapPosition) === JSON.stringify({ left: 390, top: 260 }),
    JSON.stringify(settings.current.miniMapPosition));
});

suite('a drag stops at the edge of the window', () => {
  pointer(head, 'pointerdown', 400, 270);
  pointer(head, 'pointermove', 5000, 270);
  pointer(head, 'pointerup', 5000, 270);
  check('its right edge meets the window\'s', panel.style.left === `${1024 - 268}px`, panel.style.left);
});

suite('the title bar buttons do not move the map', () => {
  const before = `${panel.style.left},${panel.style.top}`;
  const hideButton = head.querySelectorAll('button')[1];
  pointer(hideButton, 'pointerdown', 1000, 70);
  pointer(head, 'pointermove', 600, 300);
  pointer(head, 'pointerup', 600, 300);
  check('it stayed put', `${panel.style.left},${panel.style.top}` === before, `${panel.style.left},${panel.style.top}`);
  const saves = positionSaves;
  pointer(head, 'pointerdown', 900, 300);
  pointer(head, 'pointerup', 900, 300);
  check('a plain click on the title does not move or save it', positionSaves === saves
    && `${panel.style.left},${panel.style.top}` === before);
});

suite('a smaller window pulls the map back on screen', () => {
  const realWidth = dom.window.innerWidth;
  Object.defineProperty(dom.window, 'innerWidth', { value: 600, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  check('it is fully visible again', parseFloat(panel.style.left) + 268 <= 600, panel.style.left);
  Object.defineProperty(dom.window, 'innerWidth', { value: realWidth, configurable: true });
});

suite('hiding and showing keeps the dragged position', () => {
  pointer(head, 'pointerdown', 400, 70);
  pointer(head, 'pointermove', 200, 470);
  pointer(head, 'pointerup', 200, 470);
  const before = `${panel.style.left},${panel.style.top}`;
  map.setVisible(false);
  map.setVisible(true);
  check('it comes back where it was moved to', `${panel.style.left},${panel.style.top}` === before && panel.classList.contains('floating'),
    `${before} -> ${panel.style.left},${panel.style.top}`);
});

suite('a remembered position survives a reload', () => {
  const saved = settings.current.miniMapPosition!;
  const otherHost = doc.createElement('div');
  doc.body.append(otherHost);
  new MiniMap(otherHost);
  const reloaded = otherHost.querySelector<HTMLElement>('.mini-map')!;
  check('the new map is floating', reloaded.classList.contains('floating'));
  check('where it was left', reloaded.style.left === `${saved.left}px` && reloaded.style.top === `${saved.top}px`,
    `${reloaded.style.left}, ${reloaded.style.top}`);
  otherHost.remove();
});

suite('double-clicking the title puts the map back in its corner', () => {
  head.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  check('it is no longer floating', !panel.classList.contains('floating'));
  check('its inline position is cleared', panel.style.left === '' && panel.style.top === '');
  check('and the remembered position is forgotten', settings.current.miniMapPosition === null);
});

report();
dom.window.close();
