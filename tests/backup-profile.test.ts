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
  'showMiniMap', 'miniMapFollow', 'showSidebar', 'routeSmoothing', 'powerZoneBounds', 'hrZoneBounds',
];
const DEVICE = ['miniMapPosition', 'useMockDevices', 'autoConnectBle', 'debugMode', 'showRouteScene', 'librarySection', 'libraryFilters', 'stravaAutoUpload'];
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

const MY_POWER = [0.55, 0.78, 0.90, 1.05, 1.20, 1.50];
const mine = {
  ...defaults, ftp: 280, riderWeight: 70, debugMode: true, miniMapPosition: { left: 5, top: 6 }, powerZoneBounds: MY_POWER,
} as Settings;
const profile = await buildProfile(personal, mine, 1234);

const tablet = { ...defaults, ftp: 200, debugMode: false, miniMapPosition: { left: 99, top: 98 }, stravaAutoUpload: true } as Settings;

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
  check('zones are applied', patched.powerZoneBounds?.join() === MY_POWER.join());
});

report();
