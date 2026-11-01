import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();
// Node's FormData only takes Node's Blob; nothing here needs jsdom's.
const { Blob: NodeBlob } = await import('node:buffer');
globalThis.Blob = NodeBlob as typeof Blob;

const { check, report, suite } = await import('./harness');
const { buildStravaPanel } = await import('../src/ui/strava-panel');
const { showSummary } = await import('../src/ui/summary');
const { strava, STRAVA, CALLBACK_CHANNEL } = await import('../src/activity/strava');
const { settings } = await import('../src/core/settings');
const { session } = await import('../src/session/session');
const { openLibraryStore, UNAVAILABLE_STORE } = await import('../src/library/db');
const { PersonalLibrary } = await import('../src/library/personal');
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
type SessionSnapshot = import('../src/session/session').SessionSnapshot;

const doc = dom.window.document;
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 2000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 10) {
    if (condition()) return true;
    await wait();
  }
  return condition();
}

/** The relay (tokens and forwarded Strava calls) and the pop-up, faked at the browser's edges. */
const requests: { url: string; method: string }[] = [];
/** the form of every upload the relay received for Strava, in order */
const uploadForms: FormData[] = [];
let uploadReply: () => Response = () => Response.json({ id: 1, activity_id: 4242 });
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  requests.push({ url, method: init.method ?? 'GET' });
  if (url === STRAVA.relayUrl) {
    return Response.json({ access_token: 'acc', refresh_token: 'ref', expires_at: Date.now() / 1000 + 21600, scope: 'activity:write read' });
  }
  if (url === `${STRAVA.relayApi}/athlete`) return Response.json({ firstname: 'Ada', lastname: 'Rider' });
  if (url === `${STRAVA.relayApi}/uploads`) {
    if (init.body instanceof FormData) uploadForms.push(init.body);
    return uploadReply();
  }
  if (url === `${STRAVA.relayApi}/deauthorize`) return Response.json({});
  throw new TypeError(`unexpected request ${url}`);
}) as typeof fetch;

const popups: string[] = [];
dom.window.open = ((url: string) => { popups.push(url); return {}; }) as typeof window.open;

/** What strava-callback.html does once Strava sends the pop-up back. */
function approveInPopup(scope = 'read,activity:write') {
  const state = new URL(popups.at(-1)!).searchParams.get('state');
  const channel = new BroadcastChannel(CALLBACK_CHANNEL);
  channel.postMessage({ state, code: 'c0de', scope, error: null });
  channel.close();
}

const uploadsPosted = () => requests.filter((r) => r.url === `${STRAVA.relayApi}/uploads`).length;
const panel = () => doc.querySelector('#strava-panel')!;
const panelButton = (text: string) =>
  Array.from(panel().querySelectorAll('button')).find((b) => b.textContent === text);
const toasts = () => Array.from(doc.querySelectorAll('.toast')).map((t) => t.textContent ?? '');
const summaryStrava = () => doc.querySelector('#summary-overlay .strava-slot')?.firstElementChild as HTMLElement | null;

/** A finished two-minute ride that started at `start`. */
function finishedRide(start: Date): SessionSnapshot {
  session.startedAt = start;
  session.exported = false;
  const samples = Array.from({ length: 120 }, (_, t) => ({
    t, power: 200, targetPower: 200, heartRate: 140, cadence: 90, speed: 30, distance: t * 8.3,
  }));
  return { workout: undefined, samples, laps: [] } as unknown as SessionSnapshot;
}

buildStravaPanel();

// The ride log, which the summary writes and links to Strava.
const personal = new PersonalLibrary(openLibraryStore(new IDBFactory()));
const logged = () => personal.rides();
const loggedRide = async (start: Date) => (await logged()).find((r) => r.startedAt === start.getTime());

suite('the panel starts disconnected', () => {
  check('offers Connect to Strava', Boolean(panelButton('Connect to Strava')));
  check('says the approval lasts', /approve once in this browser/.test(panel().textContent ?? ''));
  check('offers no auto-upload before connecting', !panel().querySelector('input[type="checkbox"]'));
});

panelButton('Connect to Strava')!.click();
await wait();
const waitingText = panel().textContent ?? '';
const hadCancel = Boolean(panelButton('Cancel'));
approveInPopup();
const connected = await until(() => /Connected as Ada Rider/.test(panel().textContent ?? ''));

suite('connecting from Settings', () => {
  check('opens Strava’s approval page in a pop-up', popups.length === 1 && popups[0].startsWith(STRAVA.authorizeUrl));
  check('the pop-up returns to the callback page',
    new URL(popups[0]).searchParams.get('redirect_uri') === 'http://localhost:5173/strava-callback.html');
  check('waits with a Cancel button', /Waiting for Strava/.test(waitingText) && hadCancel);
  check('shows who is connected', connected, panel().textContent ?? '');
  check('auto-upload is offered, off by default',
    panel().querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked === false);
  check('a toast confirms it', toasts().some((t) => t.includes('Connected to Strava as Ada Rider')));
});

{
  const box = panel().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change'));
}
const rideA = new Date('2026-10-25T07:00:00');
showSummary(finishedRide(rideA), personal);
const autoDone = await until(() => summaryStrava()?.tagName === 'A');
const autoForm = uploadForms.at(-1);
const link = summaryStrava() as HTMLAnchorElement | null;
await until(() => false, 50);
const rideALogged = await loggedRide(rideA);

suite('auto-upload on finish', () => {
  check('the setting is saved', settings.current.stravaAutoUpload === true);
  check('the ride uploads without a click', uploadsPosted() === 1, String(uploadsPosted()));
  check('the button becomes a link to the activity', autoDone && link?.textContent === 'View on Strava');
  check('which points at it', link?.getAttribute('href') === 'https://www.strava.com/activities/4242');
  check('opens in a new tab', link?.getAttribute('target') === '_blank');
  check('the ride counts as saved, so New ride will not warn', session.exported);
  check('no pop-up was needed', popups.length === 1);
  const description = String(autoForm?.get('description') ?? '');
  check('the upload carries a description', description.length > 0);
  check('a free ride without a route starts with its numbers', description.startsWith('Duration '), description);
  check('and ends with the credit', description.endsWith('\n\nRidden on Cycle Indoors'), description);
});

suite('the ride log', () => {
  check('the finished ride is logged', rideALogged !== undefined && rideALogged.duration >= 119 && rideALogged.avgPower === 200,
    JSON.stringify(rideALogged));
  check('a free ride names no workout', rideALogged?.workout === undefined);
  check('and links to the Strava activity once uploaded', rideALogged?.stravaActivityId === 4242);
});

showSummary(finishedRide(rideA), personal);
await wait(30);
const afterReopen = await logged();
suite('reopening that summary', () => {
  check('does not upload it again', uploadsPosted() === 1, String(uploadsPosted()));
  check('still links to the activity', summaryStrava()?.textContent === 'View on Strava');
  check('does not log the ride twice', afterReopen.length === 1 && afterReopen[0].stravaActivityId === 4242, String(afterReopen.length));
});

settings.patch({ stravaAutoUpload: false });
uploadReply = () => Response.json({ id: 2, error: "x.fit duplicate of <a href='/activities/99'>Ride</a>" });
const rideB = new Date('2026-10-25T08:00:00');
showSummary(finishedRide(rideB), personal);
await wait(30);
const waitedForClick = uploadsPosted() === 1 && summaryStrava()?.textContent === 'Upload to Strava';
summaryStrava()!.click();
const dupDone = await until(() => summaryStrava()?.textContent === 'Already on Strava');
await until(() => false, 50);
const rideBLogged = await loggedRide(rideB);

suite('auto-upload off', () => {
  check('the ride waits for the button', waitedForClick);
  check('pressing it uploads', uploadsPosted() === 2, String(uploadsPosted()));
  check('a duplicate links to the ride already there',
    dupDone && summaryStrava()?.getAttribute('href') === 'https://www.strava.com/activities/99');
  check('and the ride log links to it too', rideBLogged?.stravaActivityId === 99);
});

// Storage the browser refuses: the summary is unaffected, and nothing is logged.
const refused = new PersonalLibrary(Promise.resolve(UNAVAILABLE_STORE));
showSummary(finishedRide(new Date('2026-10-25T08:30:00')), refused);
await wait(30);
const refusedRides = await refused.rides();
suite('a ride log that cannot be written', () => {
  check('does not stop the summary', doc.querySelector('#summary-overlay .summary-grid') !== null);
  check('and logs nothing', refusedRides.length === 0);
});

uploadReply = () => new Response('', { status: 500 });
showSummary(finishedRide(new Date('2026-10-25T09:00:00')));
summaryStrava()!.click();
const failedBack = await until(() => toasts().some((t) => t.startsWith('Upload to Strava failed')));

suite('a failed upload can be retried', () => {
  check('the failure is reported', failedBack, toasts().join(' | '));
  check('the button is back', summaryStrava()?.textContent === 'Upload to Strava');
  check('the ride is not marked as saved', !session.exported);
  check('the failed attempt did reach Strava', uploadsPosted() === 3, String(uploadsPosted()));
});

// The relay is up but cannot reach Strava.
uploadReply = () => new Response('strava unreachable', { status: 502 });
summaryStrava()!.click();
const downBack = await until(() => toasts().some((t) => t.includes('Strava could not be reached')));

suite('a Strava the relay cannot reach', () => {
  check('is reported as such', downBack
    && toasts().some((t) => t === 'Upload to Strava failed: Strava could not be reached. Try again later.'), toasts().join(' | '));
  check('the button is back to press again', summaryStrava()?.textContent === 'Upload to Strava');
  check('the rider stays connected', strava.status === 'connected');
  check('the attempt went to the relay', uploadsPosted() === 4, String(uploadsPosted()));
});

panelButton('Disconnect')!.click();
const disconnected = await until(() => Boolean(panelButton('Connect to Strava')));
settings.patch({ stravaAutoUpload: true });
uploadReply = () => Response.json({ id: 3, activity_id: 7 });
showSummary(finishedRide(new Date('2026-10-25T10:00:00')));
await wait(30);
const noAutoPopup = popups.length === 1 && uploadsPosted() === 4;
summaryStrava()!.click();
await wait();
const popupFromClick = popups.length === 2;
approveInPopup();
const uploadedAfterConnect = await until(() => summaryStrava()?.textContent === 'View on Strava');

suite('uploading while disconnected', () => {
  check('Disconnect revokes the app on Strava, through the relay', requests.some((r) => r.url === `${STRAVA.relayApi}/deauthorize`));
  check('and the panel offers Connect again', disconnected);
  check('auto-upload never opens a pop-up by itself', noAutoPopup);
  check('pressing Upload connects first', popupFromClick);
  check('then uploads', uploadedAfterConnect && uploadsPosted() === 5, String(uploadsPosted()));
});

panelButton('Disconnect')!.click();
await until(() => Boolean(panelButton('Connect to Strava')));
showSummary(finishedRide(new Date('2026-10-25T11:00:00')));
summaryStrava()!.click();
await wait();
approveInPopup('read');
const refusedScope = await until(() => toasts().some((t) => t.includes('Upload permission was not granted')));

suite('unticking upload permission on Strava', () => {
  check('is explained', refusedScope, toasts().join(' | '));
  check('leaves it disconnected', strava.status === 'disconnected');
  check('and uploads nothing', uploadsPosted() === 5, String(uploadsPosted()));
  check('the button is still there to try again', summaryStrava()?.textContent === 'Upload to Strava');
});

// Connected again, by the button: the description describes what the summary opened on.
const workoutRide = (start: Date): SessionSnapshot => ({
  ...finishedRide(start),
  workout: { name: 'Sweet Spot 3x15', duration: 120, segments: [], textEvents: [], source: 'zwo' },
} as unknown as SessionSnapshot);
const hilly = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Hilly loop');
settings.patch({ stravaAutoUpload: false });
uploadReply = () => Response.json({ id: 5, activity_id: 55 });
const routeName = courseStore.load(hilly)!.name;
showSummary(workoutRide(new Date('2026-10-25T12:00:00')));
courseStore.load({ ...hilly, name: 'Another route' });
summaryStrava()!.click();
await wait();
approveInPopup();
await until(() => summaryStrava()?.textContent === 'View on Strava');
const clickedForm = uploadForms.at(-1);

courseStore.unload();
settings.patch({ stravaAutoUpload: true });
uploadReply = () => Response.json({ id: 6, activity_id: 66 });
showSummary(workoutRide(new Date('2026-10-25T13:00:00')));
await until(() => summaryStrava()?.textContent === 'View on Strava');
const autoWorkoutForm = uploadForms.at(-1);

suite('the description Strava receives', () => {
  const clicked = String(clickedForm?.get('description') ?? '');
  check('names the route the summary opened on, though another was loaded before the click',
    clicked.startsWith(`Route: ${routeName}\nWorkout: Sweet Spot 3x15\n\n`), clicked.split('\n').slice(0, 3).join(' | '));
  check('not the route loaded afterwards', !clicked.includes('Another route'));
  const auto = String(autoWorkoutForm?.get('description') ?? '');
  check('auto-upload sends one too, starting with the workout', auto.startsWith('Workout: Sweet Spot 3x15\n'), auto);
  check('the button and auto-upload write the same numbers for the same ride',
    clicked.split('\n\n').slice(1).join() === auto.split('\n\n').slice(1).join());
  const files = clickedForm?.getAll('file') ?? [];
  check('exactly one file goes to Strava', files.length === 1, String(files.length));
  check('and it is the .fit, not an image', (files[0] as File | undefined)?.name.endsWith('.fit') === true
    && !(files[0] as File).type.startsWith('image/'));
  check('no other part of the form is a file', [...(clickedForm?.entries() ?? [])]
    .filter(([, value]) => typeof value !== 'string').length === 1);
});

// The rider's own zones reach the description: 20 minutes at 154 W of a 200 W
// FTP is Z2 once Z2 ends at 78 %, Z3 by the formula.
const zoneSettings = { ftp: settings.current.ftp, powerZoneBounds: settings.current.powerZoneBounds };
settings.patch({ ftp: 200, powerZoneBounds: [0.55, 0.78, 0.90, 1.05, 1.20, 1.50] });
uploadReply = () => Response.json({ id: 7, activity_id: 77 });
{
  const ride = finishedRide(new Date('2026-10-25T14:00:00'));
  showSummary({
    ...ride,
    samples: Array.from({ length: 1200 }, (_, t) => ({ t, power: 154, targetPower: 0, heartRate: 140, cadence: 90, speed: 30, distance: t * 8.3 })),
  } as unknown as SessionSnapshot);
}
await until(() => summaryStrava()?.textContent === 'View on Strava');
const zonedForm = uploadForms.at(-1);
settings.patch(zoneSettings);

suite('the description\'s zones are the rider\'s', () => {
  const lines = String(zonedForm?.get('description') ?? '').split('\n');
  const power = lines.find((l) => l.startsWith('Power zones: '));
  check('the power zone line reads Z2 20:00', power === 'Power zones: Z2 20:00', String(power));
});

// A ride on a route: every sample carries a GPS fix, as the session records
// them, so the .fit has a track and Strava must not be told it is a trainer ride.
const routeRide = (start: Date): SessionSnapshot => {
  const ride = finishedRide(start);
  return {
    ...ride,
    samples: ride.samples.map((s) => ({ ...s, lat: 50.06 + s.t * 1e-5, lon: 19.94, altitude: 220 })),
  } as unknown as SessionSnapshot;
};
courseStore.load(hilly);
uploadReply = () => Response.json({ id: 8, activity_id: 88 });
showSummary(routeRide(new Date('2026-10-25T15:00:00')));
await until(() => summaryStrava()?.textContent === 'View on Strava');
const autoRouteForm = uploadForms.at(-1);

settings.patch({ stravaAutoUpload: false });
uploadReply = () => Response.json({ id: 9, activity_id: 99 });
showSummary(routeRide(new Date('2026-10-25T16:00:00')));
courseStore.unload();
summaryStrava()!.click();
await until(() => summaryStrava()?.textContent === 'View on Strava');
const unloadedRouteForm = uploadForms.at(-1);

suite('the activity type Strava receives', () => {
  check('a free ride without a route is a trainer ride', autoForm?.get('trainer') === '1', String(autoForm?.get('trainer')));
  check('and asks for no sport type', autoForm?.get('sport_type') === null, String(autoForm?.get('sport_type')));
  check('a workout without a route is a trainer ride too', autoWorkoutForm?.get('trainer') === '1'
    && autoWorkoutForm?.get('sport_type') === null);
  check('auto-upload of a route ride asks for a virtual ride',
    autoRouteForm?.get('sport_type') === 'VirtualRide', String(autoRouteForm?.get('sport_type')));
  check('and is not flagged as a trainer ride', autoRouteForm?.get('trainer') === null, String(autoRouteForm?.get('trainer')));
  check('a route unloaded before pressing Upload still sends a virtual ride',
    unloadedRouteForm !== autoRouteForm && unloadedRouteForm?.get('sport_type') === 'VirtualRide',
    String(unloadedRouteForm?.get('sport_type')));
  check('with no trainer flag', unloadedRouteForm?.get('trainer') === null, String(unloadedRouteForm?.get('trainer')));
});
settings.patch({ stravaAutoUpload: false });

// Strava may be blocked where the rider is: only the approval page may need it.
suite('nothing but the approval pop-up goes to strava.com', () => {
  const onStrava = requests.filter((r) => new URL(r.url).hostname.endsWith('strava.com'));
  check('across connecting, the button, auto-upload and Disconnect, no request went to strava.com',
    onStrava.length === 0, onStrava.map((r) => r.url).join(' '));
  check('every request went to the relay', requests.every((r) => r.url.startsWith(STRAVA.relayUrl)));
  check('each connect opened Strava\'s own approval page',
    popups.length > 1 && popups.every((u) => u.startsWith(STRAVA.authorizeUrl)), String(popups.length));
});

report();
