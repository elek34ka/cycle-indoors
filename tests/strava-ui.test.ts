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

panelButton('Connect to Strava')!.click();
await wait();
const waitingText = panel().textContent ?? '';
const hadCancel = Boolean(panelButton('Cancel'));
approveInPopup();
const connected = await until(() => /Connected as Ada Rider/.test(panel().textContent ?? ''));

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

// Disconnected, the rider connects from the summary but unticks upload on Strava's page.
const uploadsBeforeRefusal = uploadsPosted();
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
  check('and uploads nothing', uploadsPosted() === uploadsBeforeRefusal, String(uploadsPosted()));
  check('the button is still there to try again', summaryStrava()?.textContent === 'Upload to Strava');
});

suite('nothing but the approval pop-up goes to strava.com', () => {
  const onStrava = requests.filter((r) => new URL(r.url).hostname.endsWith('strava.com'));
  check('across connecting, the button, auto-upload and Disconnect, no request went to strava.com',
    onStrava.length === 0, onStrava.map((r) => r.url).join(' '));
  check('every request went to the relay', requests.every((r) => r.url.startsWith(STRAVA.relayUrl)));
  check('each connect opened Strava\'s own approval page',
    popups.length > 1 && popups.every((u) => u.startsWith(STRAVA.authorizeUrl)), String(popups.length));
});

report();
