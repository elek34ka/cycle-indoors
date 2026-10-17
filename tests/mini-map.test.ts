import { setupDom } from './dom-setup';
const dom = setupDom();

const { MiniMap } = await import('../src/ui/mini-map');
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

report();
dom.window.close();
