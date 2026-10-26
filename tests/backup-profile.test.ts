import { IDBFactory } from 'fake-indexeddb';

const { buildProfile, readProfile, applyProfile, NotAProfile } = await import('../src/backup/profile');
const { settings, DEVICE_SETTINGS, personalSettings, settingsFromBackup } = await import('../src/core/settings');
const { openLibraryStore } = await import('../src/library/db');
const { PersonalLibrary } = await import('../src/library/personal');
const { formatKey, generateKey } = await import('../src/backup/key');
const { check, report, suite } = await import('./harness');
type Settings = import('../src/core/settings').Settings;

// Every setting, on one side or the other. Adding a setting fails this until
// it is put on a side on purpose.
const PERSONAL = [
  'ftp', 'hrMax', 'riderWeight', 'bikeWeight', 'wheelCircumference', 'smoothPowerSeconds',
  'showMiniMap', 'miniMapFollow', 'showSidebar', 'routeSmoothing',
];
const DEVICE = ['miniMapPosition', 'useMockDevices', 'autoConnectBle', 'debugMode', 'librarySection', 'libraryFilters', 'stravaAutoUpload'];
const defaults = settings.current as Settings;

suite('which settings travel', () => {
  check('every setting is personal or device-only', Object.keys(defaults).sort().join() === [...PERSONAL, ...DEVICE].sort().join(),
    Object.keys(defaults).sort().join());
  check('the device-only list', [...DEVICE_SETTINGS].sort().join() === [...DEVICE].sort().join());
  check('a backup carries exactly the personal ones', Object.keys(personalSettings(defaults)).sort().join() === [...PERSONAL].sort().join());
});

const enc = (s: string) => new TextEncoder().encode(s);
const factory = new IDBFactory();
const personal = new PersonalLibrary(openLibraryStore(factory));
const big = new Uint8Array(2 * 1024 * 1024).fill(65);
const store = await openLibraryStore(factory);
await store.save({ sha256: 'gpx', name: 'huge.gpx', bytes: big, route: { name: 'Huge', distance: 100_000, ascent: 900, start: [1, 2], profile: [[0, 1]] } });
await store.setDone('catalog:workout:a', true);
await store.follow('plan:Gravel');
await store.logRide({ startedAt: 5, duration: 3600, distance: 30_000, avgPower: 200, normalisedPower: 210, tss: 60, ascent: 0 });

const mine = { ...defaults, ftp: 280, riderWeight: 70, debugMode: true, miniMapPosition: { left: 5, top: 6 } } as Settings;
const profile = await buildProfile(personal, mine, 1234);
const json = JSON.stringify(profile);
const keyText = formatKey(generateKey());

suite('building a profile', () => {
  check('holds marks, plan, library, rides and personal settings',
    profile.done.length === 1 && profile.followed === 'plan:Gravel' && profile.library.length === 1
      && profile.rides.length === 1 && profile.settings.ftp === 280 && profile.madeAt === 1234);
  check('no file bytes', !('bytes' in profile.library[0]) && !json.includes('AAAAAAAA'));
  check('a 2 MB file contributes well under 1 KB', json.length < 1024, `${json.length} bytes`);
  check('no device settings', !('debugMode' in profile.settings) && !('miniMapPosition' in profile.settings));
  check('no Strava tokens or recovery key', !/access_token|refresh_token|strava/i.test(json) && !json.includes(keyText.slice(4)));
});

suite('reading a profile back', () => {
  check('a profile reads back as itself', JSON.stringify(readProfile(JSON.parse(json))) === json);
  let notOne = 0;
  for (const bad of [null, 'text', [], { format: 2 }, { done: [] }]) {
    try { readProfile(bad); } catch (e) { if (e instanceof NotAProfile) notOne++; }
  }
  check('anything that is not a profile is refused', notOne === 5);
  const loose = readProfile({ format: 1, done: [{ key: 'ok', doneAt: 1 }, { doneAt: 2 }], rides: [{ tss: 1 }], library: [{ sha256: 'x', name: 'x', bytes: [1] }] });
  check('records without their keys are dropped', loose.done.length === 1 && loose.rides.length === 0);
  check('bytes never come in from a backup', loose.library.length === 1 && !('bytes' in loose.library[0]));
});

const tablet = { ...defaults, ftp: 200, debugMode: false, miniMapPosition: { left: 99, top: 98 }, stravaAutoUpload: true } as Settings;
const fromLaptop = settingsFromBackup(tablet, profile.settings);
const fromOld = settingsFromBackup(tablet, { ftp: 300, futureSetting: 'x' } as Partial<Settings>);

suite('settings from a backup', () => {
  check('personal settings come from the backup', fromLaptop.ftp === 280 && fromLaptop.riderWeight === 70);
  check('device settings stay', fromLaptop.debugMode === false && fromLaptop.miniMapPosition?.left === 99 && fromLaptop.stravaAutoUpload);
  check('an older backup gets defaults for what it lacks', fromOld.ftp === 300 && fromOld.riderWeight === defaults.riderWeight
    && fromOld.hrMax === defaults.hrMax);
  check('unknown fields are dropped', !('futureSetting' in fromOld));
});

// Applying replaces the database, then the settings.
const other = new IDBFactory();
const there = new PersonalLibrary(openLibraryStore(other));
const otherStore = await openLibraryStore(other);
await otherStore.save({ sha256: 'own', name: 'own.zwo', bytes: enc('own') });
await otherStore.setDone('builtin:own', true);
let patched: Settings = { ...tablet };
await applyProfile(profile, there, { current: tablet, patch: (v) => { patched = { ...patched, ...v }; } });
const afterApply = await there.snapshot();
const ownGone = !(await otherStore.list()).some((f) => f.sha256 === 'own');

suite('applying a profile', () => {
  check('the database is exactly the backup\'s', afterApply.done.map((m) => m.key).join() === 'catalog:workout:a'
    && afterApply.followed === 'plan:Gravel' && afterApply.rides.length === 1
    && afterApply.library.map((f) => f.sha256).join() === 'gpx');
  check('this device\'s own file is gone', ownGone);
  check('settings: personal from the backup, device kept', patched.ftp === 280 && patched.debugMode === false
    && patched.miniMapPosition?.left === 99);
});

report();
