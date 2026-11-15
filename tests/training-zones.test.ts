import { setupDom } from './dom-setup';
const dom = setupDom();

const {
  POWER_ZONES, HR_ZONES, DEFAULT_POWER_BOUNDS, DEFAULT_HR_BOUNDS,
  powerZones, hrZones, zoneForRatio, zoneForPower, zoneForHr, boundsProblem, riderZones,
} = await import('../src/core/zones');
const { restoreSettings, zoneBoundsFromPercent, settings } = await import('../src/core/settings');
const { zoneRows } = await import('../src/ui/zone-editor');
const { buildSettingsView } = await import('../src/ui/settings-view');
const { computeMetrics } = await import('../src/session/metrics');
const { check, report, suite } = await import('./harness');
type Sample = import('../src/session/metrics').Sample;

/** `seconds` of steady riding at `power` W and `hr` bpm. */
const steady = (seconds: number, power: number, hr?: number): Sample[] =>
  Array.from({ length: seconds }, (_, i) => ({ t: i + 1, power, targetPower: 0, heartRate: hr, distance: i * 8 }));

/** The tables as they were before zones could be edited, field by field. */
const OLD_POWER = [
  { id: 1, key: 'z1', label: 'Active recovery', max: 0.55, color: '#7a8694' },
  { id: 2, key: 'z2', label: 'Endurance',       max: 0.75, color: '#3f8fd8' },
  { id: 3, key: 'z3', label: 'Tempo',           max: 0.90, color: '#3fc07a' },
  { id: 4, key: 'z4', label: 'Threshold',       max: 1.05, color: '#f0c33c' },
  { id: 5, key: 'z5', label: 'VO2 max',         max: 1.20, color: '#f08a35' },
  { id: 6, key: 'z6', label: 'Anaerobic',       max: 1.50, color: '#e4563c' },
  { id: 7, key: 'z7', label: 'Neuromuscular',   max: Infinity, color: '#c2437f' },
];
const OLD_HR = [
  { id: 1, key: 'z1', label: 'Recovery',  max: 0.60, color: '#7a8694' },
  { id: 2, key: 'z2', label: 'Endurance', max: 0.70, color: '#3f8fd8' },
  { id: 3, key: 'z3', label: 'Tempo',     max: 0.80, color: '#3fc07a' },
  { id: 4, key: 'z4', label: 'Threshold', max: 0.90, color: '#f08a35' },
  { id: 5, key: 'z5', label: 'Maximum',   max: Infinity, color: '#e4563c' },
];
const same = (a: object[], b: object[]) => a.length === b.length
  && a.every((z, i) => Object.entries(b[i]).every(([k, v]) => (z as Record<string, unknown>)[k] === v)
    && Object.keys(z).length === Object.keys(b[i]).length);

/** Power bounds with Z2 ending at 78 %. */
const Z2_78 = [0.55, 0.78, 0.90, 1.05, 1.20, 1.50];
/** Heart-rate bounds with Z2 ending at 78.4 %. */
const HR_Z2_784 = [0.60, 0.784, 0.80, 0.90];

suite('the standard zones are the formula', () => {
  check('power zones equal the old table', same(POWER_ZONES, OLD_POWER), JSON.stringify(POWER_ZONES));
  check('heart-rate zones equal the old table', same(HR_ZONES, OLD_HR), JSON.stringify(HR_ZONES));
  check('powerZones() and hrZones() are the formula too', same(powerZones(), OLD_POWER) && same(hrZones(null), OLD_HR));
  check('default bounds', DEFAULT_POWER_BOUNDS.join() === '0.55,0.75,0.9,1.05,1.2,1.5' && DEFAULT_HR_BOUNDS.join() === '0.6,0.7,0.8,0.9');
});

suite('which bounds are allowed', () => {
  check('the power formula passes', boundsProblem('power', [...DEFAULT_POWER_BOUNDS]) === undefined);
  check('the heart-rate formula passes', boundsProblem('hr', [...DEFAULT_HR_BOUNDS]) === undefined);
  check('custom bounds pass', boundsProblem('power', Z2_78) === undefined && boundsProblem('hr', HR_Z2_784) === undefined);
  const refused: [string, 'power' | 'hr', unknown][] = [
    ['Z2 at 92 % under Z3 at 90 %', 'power', [0.55, 0.92, 0.90, 1.05, 1.20, 1.50]],
    ['equal neighbours', 'power', [0.55, 0.75, 0.75, 1.05, 1.20, 1.50]],
    ['heart rate at 104 %', 'hr', [0.60, 0.70, 0.80, 1.04]],
    ['power at 5 %', 'power', [0.05, 0.75, 0.90, 1.05, 1.20, 1.50]],
    ['power over 300 %', 'power', [0.55, 0.75, 0.90, 1.05, 1.20, 3.01]],
    ['heart rate under 30 %', 'hr', [0.29, 0.70, 0.80, 0.90]],
    ['NaN', 'power', [0.55, NaN, 0.90, 1.05, 1.20, 1.50]],
    ['a string', 'hr', [0.60, '0.7', 0.80, 0.90]],
    ['too few', 'power', [0.55, 0.75, 0.90]],
    ['heart-rate bounds as power', 'power', [...DEFAULT_HR_BOUNDS]],
    ['not a list', 'hr', { 0: 0.6 }],
    ['nothing', 'hr', undefined],
  ];
  for (const [label, kind, bounds] of refused) {
    const problem = boundsProblem(kind, bounds);
    check(`refused: ${label}`, typeof problem === 'string' && problem.length > 0, String(problem));
  }
});

suite('time in zones is measured against the rider\'s zones', () => {
  const mine = riderZones({ powerZoneBounds: Z2_78, hrZoneBounds: HR_Z2_784 });
  const twenty = computeMetrics(steady(1200, 154), 200, 185, mine);
  check('FTP 200, Z2 to 78 %, 20 min at 154 W: Z2 20:00, Z3 nothing',
    twenty.zones[1].seconds === 1200 && twenty.zones[2].seconds === 0, twenty.zones.map((z) => z.seconds).join());
  const standard = computeMetrics(steady(1200, 154), 200, 185);
  check('with the formula the same ride is Z3', standard.zones[2].seconds === 1200);
  const hr = computeMetrics(steady(600, 150, 140), 200, 185, mine);
  check('max HR 185, HR Z2 to 78.4 %, 600 s at 140 bpm: HR Z2 10:00',
    hr.hrZones[1].seconds === 600 && hr.hrZones.reduce((a, z) => a + z.seconds, 0) === 600, hr.hrZones.map((z) => z.seconds).join());
  const override = computeMetrics(steady(600, 230), 300, 185, mine);
  check('a workout FTP of 300, Z2 to 78 %, 600 s at 230 W: Z2 10:00', override.zones[1].seconds === 600);
  check('zone labels and colours are the usual ones',
    twenty.zones.map((z) => z.label).join() === POWER_ZONES.map((z) => z.label).join()
      && twenty.hrZones.every((z, i) => z.color === HR_ZONES[i].color));
});

suite('saved zones are checked on load', () => {
  check('missing: the formula', restoreSettings({}).powerZoneBounds === null && restoreSettings({}).hrZoneBounds === null);
  const kept = restoreSettings({ powerZoneBounds: Z2_78, hrZoneBounds: HR_Z2_784 });
  check('valid bounds survive', kept.powerZoneBounds?.join() === Z2_78.join() && kept.hrZoneBounds?.join() === HR_Z2_784.join());
  let out: ReturnType<typeof restoreSettings> | undefined;
  let threw = false;
  try {
    out = restoreSettings({ powerZoneBounds: [0.55, 0.92, 0.90, 1.05, 1.20, 1.50], hrZoneBounds: HR_Z2_784 });
  } catch { threw = true; }
  check('out-of-order power bounds load without throwing', !threw);
  check('and as the formula', out?.powerZoneBounds === null);
  check('the valid heart-rate bounds beside them are kept', out?.hrZoneBounds?.[1] === 0.784);
  const junk = restoreSettings({ powerZoneBounds: 'oops', hrZoneBounds: [1, 2] } as unknown as Parameters<typeof restoreSettings>[0]);
  check('junk of the wrong type is the formula', junk.powerZoneBounds === null && junk.hrZoneBounds === null);
});

report();
