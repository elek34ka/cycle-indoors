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

/** Strava, the relay and the pop-up, faked at the browser's edges. */
const requests: { url: string; method: string }[] = [];
let uploadReply: () => Response = () => Response.json({ id: 1, activity_id: 4242 });
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  requests.push({ url, method: init.method ?? 'GET' });
  if (url === STRAVA.relayUrl) {
    return Response.json({ access_token: 'acc', refresh_token: 'ref', expires_at: Date.now() / 1000 + 21600, scope: 'activity:write read' });
  }
  if (url === `${STRAVA.apiBase}/athlete`) return Response.json({ firstname: 'Ada', lastname: 'Rider' });
  if (url === `${STRAVA.apiBase}/uploads`) return uploadReply();
  if (url === STRAVA.deauthorizeUrl) return Response.json({});
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

const uploadsPosted = () => requests.filter((r) => r.url === `${STRAVA.apiBase}/uploads`).length;
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
showSummary(finishedRide(rideA));
const autoDone = await until(() => summaryStrava()?.tagName === 'A');
const link = summaryStrava() as HTMLAnchorElement | null;

suite('auto-upload on finish', () => {
  check('the setting is saved', settings.current.stravaAutoUpload === true);
  check('the ride uploads without a click', uploadsPosted() === 1, String(uploadsPosted()));
  check('the button becomes a link to the activity', autoDone && link?.textContent === 'View on Strava');
  check('which points at it', link?.getAttribute('href') === 'https://www.strava.com/activities/4242');
  check('opens in a new tab', link?.getAttribute('target') === '_blank');
  check('the ride counts as saved, so New ride will not warn', session.exported);
  check('no pop-up was needed', popups.length === 1);
});

showSummary(finishedRide(rideA));
await wait(30);
suite('reopening that summary', () => {
  check('does not upload it again', uploadsPosted() === 1, String(uploadsPosted()));
  check('still links to the activity', summaryStrava()?.textContent === 'View on Strava');
});

settings.patch({ stravaAutoUpload: false });
uploadReply = () => Response.json({ id: 2, error: "x.fit duplicate of <a href='/activities/99'>Ride</a>" });
showSummary(finishedRide(new Date('2026-10-25T08:00:00')));
await wait(30);
const waitedForClick = uploadsPosted() === 1 && summaryStrava()?.textContent === 'Upload to Strava';
summaryStrava()!.click();
const dupDone = await until(() => summaryStrava()?.textContent === 'Already on Strava');

suite('auto-upload off', () => {
  check('the ride waits for the button', waitedForClick);
  check('pressing it uploads', uploadsPosted() === 2, String(uploadsPosted()));
  check('a duplicate links to the ride already there',
    dupDone && summaryStrava()?.getAttribute('href') === 'https://www.strava.com/activities/99');
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

panelButton('Disconnect')!.click();
const disconnected = await until(() => Boolean(panelButton('Connect to Strava')));
settings.patch({ stravaAutoUpload: true });
uploadReply = () => Response.json({ id: 3, activity_id: 7 });
showSummary(finishedRide(new Date('2026-10-25T10:00:00')));
await wait(30);
const noAutoPopup = popups.length === 1 && uploadsPosted() === 3;
summaryStrava()!.click();
await wait();
const popupFromClick = popups.length === 2;
approveInPopup();
const uploadedAfterConnect = await until(() => summaryStrava()?.textContent === 'View on Strava');

suite('uploading while disconnected', () => {
  check('Disconnect revokes the app on Strava', requests.some((r) => r.url === STRAVA.deauthorizeUrl));
  check('and the panel offers Connect again', disconnected);
  check('auto-upload never opens a pop-up by itself', noAutoPopup);
  check('pressing Upload connects first', popupFromClick);
  check('then uploads', uploadedAfterConnect && uploadsPosted() === 4, String(uploadsPosted()));
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
  check('and uploads nothing', uploadsPosted() === 4, String(uploadsPosted()));
  check('the button is still there to try again', summaryStrava()?.textContent === 'Upload to Strava');
});

report();
