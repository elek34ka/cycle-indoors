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

suite('zones from edited bounds', () => {
  const zones = powerZones(Z2_78);
  check('names and colours are kept', zones.every((z, i) => z.label === OLD_POWER[i].label && z.color === OLD_POWER[i].color));
  check('the top zone is unbounded', zones[6].max === Infinity && hrZones(HR_Z2_784)[4].max === Infinity);
  check('77 % is Z2', zoneForRatio(0.77, zones).id === 2);
  check('78 %, the bound itself, is Z2', zoneForRatio(0.78, zones).id === 2);
  check('78.1 % is Z3', zoneForRatio(0.781, zones).id === 3);
  check('without a list, 77 % is still Z3', zoneForRatio(0.77).id === 3);
  check('watts against an FTP: 154 of 200 is Z2', zoneForPower(154, 200, zones).id === 2);
  check('144 of 185 bpm is HR Z2 with Z2 to 78.4 %', zoneForHr(144, 185, hrZones(HR_Z2_784)).id === 2);
  check('and HR Z3 with the formula', zoneForHr(144, 185).id === 3);
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

suite('the rider\'s zones', () => {
  const formula = riderZones({ powerZoneBounds: null, hrZoneBounds: null });
  check('null bounds give the standard sets', same(formula.power, OLD_POWER) && same(formula.hr, OLD_HR));
  const mine = riderZones({ powerZoneBounds: Z2_78, hrZoneBounds: HR_Z2_784 });
  check('custom bounds give custom zones', mine.power[1].max === 0.78 && mine.hr[1].max === 0.784);
  check('the standard sets are not touched', POWER_ZONES[1].max === 0.75 && HR_ZONES[1].max === 0.70);
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

suite('edited percentages become stored bounds', () => {
  const stored = zoneBoundsFromPercent('power', [55, 78, 90, 105, 120, 150]);
  check('78 % is stored as 0.78', stored?.[1] === 0.78, JSON.stringify(stored));
  const hr = zoneBoundsFromPercent('hr', [60, 78.4, 80, 90]);
  check('78.4 % is stored as exactly 0.784', hr?.[1] === 0.784, JSON.stringify(hr));
  check('rounded to 0.1 %', zoneBoundsFromPercent('hr', [60, 78.44, 80, 90])?.[1] === 0.784);
  check("the power formula's own values are null", zoneBoundsFromPercent('power', [55, 75, 90, 105, 120, 150]) === null);
  check("the heart-rate formula's own values are null", zoneBoundsFromPercent('hr', [60, 70, 80, 90]) === null);
  check('values that only round to the formula are null too', zoneBoundsFromPercent('hr', [60.04, 70, 80, 90]) === null);
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


suite('the editor\'s rows: % and watts or bpm', () => {
  const ranges = (rows: { lower: number; upper?: number }[]) => rows.map((r) => `${r.lower}-${r.upper ?? 'up'}`).join(' ');
  const power = zoneRows(powerZones(), 200, 'W');
  check('FTP 200, the formula: 0–110, 110–150, 150–180, 180–210, 210–240, 240–300, above 300',
    ranges(power) === '0-110 110-150 150-180 180-210 210-240 240-300 300-up', ranges(power));
  check('written out with % and W', power[1].range === '55–75 % · 110–150 W', power[1].range);
  check('the top zone is "above"', power[6].range === 'above 150 % · 300 W' && power[6].upper === undefined, power[6].range);
  check('Z1 starts at 0', power[0].lowerPct === '0' && power[0].lower === 0);
  const hr = zoneRows(hrZones(), 200, 'bpm');
  check('max HR 200: 0–120, 120–140, 140–160, 160–180, above 180',
    ranges(hr) === '0-120 120-140 140-160 160-180 180-up', ranges(hr));
  check('FTP 300: Z2 is 165–225 W', zoneRows(powerZones(), 300, 'W')[1].range === '55–75 % · 165–225 W');
  const mine = zoneRows(hrZones(HR_Z2_784), 185, 'bpm');
  check('HR Z2 to 78.4 % of 185 ends at 145 bpm', mine[1].upper === 145 && mine[2].lower === 145, mine[1].range);
  check('% reads 78.4 and 75, never 75.0', mine[1].upperPct === '78.4' && zoneRows(powerZones(), 200, 'W')[1].upperPct === '75');
});

// The Settings view itself, in jsdom.
const doc = dom.window.document;
settings.patch({ ftp: 200, hrMax: 200, powerZoneBounds: null, hrZoneBounds: null });
buildSettingsView();
const dialog = (kind: string) => doc.querySelector<HTMLElement>(`.zone-dialog[data-kind="${kind}"]`);
const editButton = (kind: string) => doc.querySelector<HTMLButtonElement>(`#settings-form .zone-editor .zone-edit[data-kind="${kind}"]`)!;
const lineTag = (kind: string) => doc.querySelector(`#settings-form .zone-line[data-kind="${kind}"] .zone-tag`)?.textContent ?? '';
const done = (kind: string) => dialog(kind)?.querySelector<HTMLButtonElement>('.zone-done')?.click();
/** The open pop-up for `kind`, opened by its button as a rider would, after closing the other one. */
const table = (kind: string) => {
  if (!dialog(kind)) {
    done(kind === 'power' ? 'hr' : 'power');
    editButton(kind).click();
  }
  return dialog(kind)!;
};
const rowOf = (kind: string, zone: number) => table(kind).querySelector<HTMLElement>(`.zone-edit-row[data-zone="${zone}"]`)!;
const range = (kind: string, zone: number) => rowOf(kind, zone).querySelector('.zone-range')?.textContent ?? '';
const field = (kind: string, zone: number) => rowOf(kind, zone).querySelector<HTMLInputElement>('input')!;
const tag = (kind: string) => table(kind).querySelector('.zone-tag')?.textContent ?? '';
const resetShown = (kind: string) => !table(kind).querySelector<HTMLButtonElement>('.zone-reset')!.hidden;
const errors = () => Array.from(doc.querySelectorAll('#toasts .toast-error')).map((t) => t.textContent ?? '');
const enter = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new dom.window.Event('change'));
};

suite('Settings keeps the zones behind two buttons', () => {
  check('a Training zones section between the profile and the toggles', (() => {
    const kids = Array.from(doc.querySelector('#settings-form')!.children);
    const zones = kids.findIndex((k) => k.classList.contains('zone-editor'));
    return zones > kids.findIndex((k) => k.classList.contains('field-grid')) && zones < kids.findIndex((k) => k.classList.contains('toggle-list'));
  })());
  check('it holds no zone fields or tables', doc.querySelectorAll('#settings-form .zone-editor input, #settings-form .zone-edit-row').length === 0);
  check('the buttons read Edit power zones and Edit heart-rate zones',
    editButton('power')?.textContent === 'Edit power zones' && editButton('hr')?.textContent === 'Edit heart-rate zones');
  check('each set says Formula', lineTag('power') === 'Formula' && lineTag('hr') === 'Formula');
  check('no pop-up is open', !dialog('power') && !dialog('hr'));
});

editButton('power').click();
const opened = {
  shown: Boolean(dialog('power')),
  title: dialog('power')?.querySelector('h2')?.textContent,
  focused: doc.activeElement === dialog('power')?.querySelector('input'),
  modal: dialog('power')?.querySelector('[role="dialog"]')?.getAttribute('aria-modal'),
};
done('power');
const afterDone = Boolean(dialog('power'));
editButton('power').click();
doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const afterEscape = Boolean(dialog('power'));
editButton('hr').click();
dialog('hr')!.querySelector<HTMLElement>('.zone-card')!.click();
const cardClickKeeps = Boolean(dialog('hr'));
dialog('hr')!.click();
const afterBackdrop = Boolean(dialog('hr'));
editButton('power').click();
editButton('power').click();
const onlyOne = doc.querySelectorAll('.zone-dialog').length;
done('power');

suite('a pop-up per zone set', () => {
  check('Edit power zones opens the power zones', opened.shown && opened.title === 'Power zones', String(opened.title));
  check('as a modal, with the first field focused', opened.modal === 'true' && opened.focused);
  check('Done closes it', !afterDone);
  check('so does Escape', !afterEscape);
  check('a click inside the card does not', cardClickKeeps);
  check('a click on the backdrop does', !afterBackdrop);
  check('opening twice gives one pop-up', onlyOne === 1, String(onlyOne));
});

suite('the pop-ups show the zones', () => {
  check('7 power rows and 5 heart-rate rows', table('power').querySelectorAll('.zone-edit-row').length === 7
    && table('hr').querySelectorAll('.zone-edit-row').length === 5);
  check('a field for every bound but the top zone\'s', table('power').querySelectorAll('input').length === 6
    && table('hr').querySelectorAll('input').length === 4);
  check('FTP 200: Z2 reads 55–75 % · 110–150 W', range('power', 2) === '55–75 % · 110–150 W', range('power', 2));
  check('max HR 200: Z5 reads above 90 % · 180 bpm', range('hr', 5) === 'above 90 % · 180 bpm', range('hr', 5));
  check('both are marked Formula, with no reset', tag('power') === 'Formula' && tag('hr') === 'Formula'
    && !resetShown('power') && !resetShown('hr'));
  check('fields step by 0.1', field('power', 2).step === '0.1');
});

enter(field('power', 2), '78');
const afterRaise = { z2: range('power', 2), z3: range('power', 3), stored: settings.current.powerZoneBounds, tag: tag('power'), reset: resetShown('power') };
suite('editing a bound', () => {
  check('Z2 ends at 78 % and 156 W', afterRaise.z2 === '55–78 % · 110–156 W', afterRaise.z2);
  check('Z3 starts there', afterRaise.z3 === '78–90 % · 156–180 W', afterRaise.z3);
  check('stored as fractions', afterRaise.stored?.join() === Z2_78.join(), JSON.stringify(afterRaise.stored));
  check('the table says Custom and offers a reset', afterRaise.tag === 'Custom' && afterRaise.reset);
  check('and so does the line in Settings, with the pop-up still open', lineTag('power') === 'Custom' && Boolean(dialog('power')));
});

const errorsBefore = errors().length;
enter(field('power', 2), '92');
const outOfOrder = { field: field('power', 2).value, stored: settings.current.powerZoneBounds, toast: errors().slice(errorsBefore) };
enter(field('hr', 4), '104');
const tooHigh = { field: field('hr', 4).value, stored: settings.current.hrZoneBounds, toast: errors().slice(errorsBefore + 1) };
enter(field('hr', 2), '');
const empty = { field: field('hr', 2).value, toast: errors().slice(errorsBefore + 2) };
enter(field('power', 1), '78.04');
const roundsOnto = { field: field('power', 1).value, stored: settings.current.powerZoneBounds };
suite('an invalid bound is refused', () => {
  check('92 % under Z3\'s 90 %: a message', outOfOrder.toast.length === 1 && /Z2 must end between 55 % and 90 % of FTP/.test(outOfOrder.toast[0]),
    JSON.stringify(outOfOrder.toast));
  check('the field shows 78 again', outOfOrder.field === '78', outOfOrder.field);
  check('nothing is saved', outOfOrder.stored?.join() === Z2_78.join());
  check('heart rate at 104 %: a message', tooHigh.toast.length === 1 && /Z4 must end between 80 % and 100 % of max HR/.test(tooHigh.toast[0]),
    JSON.stringify(tooHigh.toast));
  check('the field shows 90 again, and heart rate stays the formula', tooHigh.field === '90' && tooHigh.stored === null);
  check('an empty field is refused too', empty.toast.length === 1 && empty.field === '70', JSON.stringify(empty));
  check('a value that rounds onto its neighbour is refused', roundsOnto.field === '55' && roundsOnto.stored?.join() === Z2_78.join(),
    JSON.stringify(roundsOnto));
});

// FTP edited in its own field, as the rider would.
const ftpField = Array.from(doc.querySelectorAll<HTMLElement>('#settings-form .field-grid .field'))
  .find((f) => f.querySelector('label')?.textContent === 'FTP')!.querySelector<HTMLInputElement>('input')!;
done('power');
done('hr');
enter(ftpField, '300');
suite('a new FTP moves the watts, not the %', () => {
  check('Z2 reads 55–78 % · 165–234 W', range('power', 2) === '55–78 % · 165–234 W', range('power', 2));
  check('the field still says 78', field('power', 2).value === '78');
  check('the stored bounds are unchanged', settings.current.powerZoneBounds?.join() === Z2_78.join());
});
enter(ftpField, '200');

enter(field('hr', 2), '78.4');
table('power').querySelector<HTMLButtonElement>('.zone-reset')!.click();
suite('Reset to formula resets one table', () => {
  check('power is the formula again', settings.current.powerZoneBounds === null && range('power', 2) === '55–75 % · 110–150 W'
    && tag('power') === 'Formula' && !resetShown('power'), range('power', 2));
  check('heart rate stays custom', settings.current.hrZoneBounds?.join() === HR_Z2_784.join() && tag('hr') === 'Custom'
    && field('hr', 2).value === '78.4');
});

enter(field('power', 2), '78');
enter(field('power', 2), '75');
suite('edited back to the formula by hand', () => {
  check('stored as the formula', settings.current.powerZoneBounds === null);
  check('marked Formula with no reset', tag('power') === 'Formula' && !resetShown('power'));
});

enter(field('power', 2), '78');
// The page's own buttons sit behind the pop-up, so close it first, as a rider must.
done('power');
done('hr');
Array.from(doc.querySelectorAll<HTMLButtonElement>('#settings-form button')).find((b) => b.textContent === 'Reset to defaults')!.click();
suite('Reset to defaults resets both tables', () => {
  check('both stored as the formula', settings.current.powerZoneBounds === null && settings.current.hrZoneBounds === null);
  check('both tables show it', tag('power') === 'Formula' && tag('hr') === 'Formula'
    && field('power', 2).value === '75' && field('hr', 2).value === '70');
  check('at the default FTP', range('power', 2) === `55–75 % · ${Math.round(0.55 * settings.current.ftp)}–${Math.round(0.75 * settings.current.ftp)} W`,
    range('power', 2));
  check('and the FTP field shows it too', ftpField.value === String(settings.current.ftp));
  check('the lines in Settings say Formula', lineTag('power') === 'Formula' && lineTag('hr') === 'Formula');
});

// A closed pop-up stops listening: a later change must not reach its detached table.
done('power');
done('hr');
const listening = (settings as unknown as { handlers: Map<string, Set<unknown>> }).handlers.get('change')?.size ?? 0;
editButton('power').click();
const whileOpen = (settings as unknown as { handlers: Map<string, Set<unknown>> }).handlers.get('change')?.size ?? 0;
done('power');
const afterClose = (settings as unknown as { handlers: Map<string, Set<unknown>> }).handlers.get('change')?.size ?? 0;
suite('a closed pop-up lets go of the settings', () => {
  check('one more listener while open, none left after', whileOpen === listening + 1 && afterClose === listening,
    `${listening} → ${whileOpen} → ${afterClose}`);
});

report();
