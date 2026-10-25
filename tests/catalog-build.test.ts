import { readFileSync } from 'node:fs';
import { setupDom } from './dom-setup';
setupDom();

const { buildCatalog, naturalCompare } = await import('../src/catalog/build');
const { validateIndex } = await import('../src/catalog/types');
const { check, report, suite } = await import('./harness');

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string) => ({ path, bytes: enc(text) });

// Shaped like the owner's real files: a Zwift export with `pace="0"` on every
// block, and one that writes SteadyState with PowerLow/PowerHigh, not Power.
const FORTY_TWENTY = `<workout_file>
    <author>M.De Jode (TK.be)</author>
    <name>The Famous 40/20's</name>
    <description>According to the cannondale coach this is a classic.</description>
    <sportType>bike</sportType>
    <tags/>
    <workout>
        <Warmup Duration="600" PowerLow="0.24982758" PowerHigh="0.72568965" pace="0"/>
        <IntervalsT Repeat="12" OnDuration="40" OffDuration="20" OnPower="1.2045" OffPower="0.55327582" pace="0"/>
        <SteadyState Duration="300" Power="0.65672415" pace="0"/>
        <IntervalsT Repeat="12" OnDuration="40" OffDuration="20" OnPower="1.2045" OffPower="0.55449998" pace="0"/>
        <SteadyState Duration="300" Power="0.65672415" pace="0"/>
        <IntervalsT Repeat="6" OnDuration="40" OffDuration="20" OnPower="1.2045" OffPower="0.55327582" pace="0"/>
        <Cooldown Duration="600" PowerLow="0.55327582" PowerHigh="0.24982758" pace="0"/>
    </workout>
</workout_file>`;

const RUSSIAN_STEPS = `<workout_file>
    <author>Pav Bryan (Direct Power Coaching)</author>
	<name>5. Russian Steps - Speed Style!</name>
	<description>Leg speed &amp; efficiency

15 sec max 45 sec easy</description>
	<sportType>bike</sportType>
	<workout>
		<Warmup Duration="600" PowerLow="0.4" PowerHigh="0.4">
		</Warmup>
		<SteadyState Duration="15" PowerLow="0.6" PowerHigh="0.6">
		</SteadyState>
		<SteadyState Duration="45" PowerLow="0.5" PowerHigh="0.5">
		</SteadyState>
		<Cooldown Duration="540" PowerLow="0.4" PowerHigh="0.4">
		</Cooldown>
	</workout>
</workout_file>`;

const CYRILLIC_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cycle Indoors" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>исследуем ближайшие холмы</name></metadata>
  <trk><name>исследуем ближайшие холмы</name><type>cycling</type><trkseg>
    <trkpt lat="41.6357150" lon="41.6062020"><ele>2.30</ele></trkpt>
    <trkpt lat="41.6356710" lon="41.6061260"><ele>2.29</ele></trkpt>
    <trkpt lat="41.6346370" lon="41.6048960"><ele>12.06</ele></trkpt>
  </trkseg></trk>
</gpx>`;

const NOW = new Date('2026-10-25T10:00:00Z');

const build = await buildCatalog([
  file('workouts/vo2/The_Famous_40_20_s.zwo', FORTY_TWENTY),
  file('workouts/WO5_Russian_Steps_Speed_Style.zwo', RUSSIAN_STEPS),
  file('workouts/my_easy-spin.zwo', '<workout_file><workout><SteadyState Duration="1200" Power="0.6"/></workout></workout_file>'),
  file('workouts/broken.zwo', FORTY_TWENTY.slice(0, 300)),
  file('workouts/wrong-place.gpx', CYRILLIC_GPX),
  file('workouts/notes.json', '{}'),
  file('routes/georgia/batumi/batumi_first_ride_.gpx', CYRILLIC_GPX),
  file('routes/sample-hilly-loop.gpx', readFileSync('samples/sample-hilly-loop.gpx', 'utf8')),
  file('routes/one-point.gpx', '<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>'),
  file('.DS_Store', 'junk'),
  file('workouts/.DS_Store', 'junk'),
  file('routes/.hidden/x.gpx', CYRILLIC_GPX),
  file('README.md', '# notes'),
], NOW);

const { index, problems, errors, files } = build;
const workout = (id: string) => index.workouts.find((w) => w.id === id);
const route = (id: string) => index.routes.find((r) => r.id === id);
const problem = (path: string) => problems.find((p) => p.path === path);

suite('the index lists what parsed, in natural order of id', () => {
  check('no build errors', errors.length === 0, errors.join('; '));
  check('three workouts', index.workouts.length === 3, index.workouts.map((w) => w.id).join(', '));
  check('two routes', index.routes.length === 2, index.routes.map((r) => r.id).join(', '));
  check('no plans', index.plans.length === 0);
  check('workouts in natural order of id', index.workouts.map((w) => w.id).join() === [...index.workouts.map((w) => w.id)].sort(naturalCompare).join());
  check('version 1, built at the given time', index.version === 1 && index.builtAt === '2026-10-25T10:00:00.000Z');
  check('the app accepts the index it builds', validateIndex(JSON.parse(JSON.stringify(index))).ok);
});

suite('ids come from the path, tags from the sub-folders', () => {
  const w = workout('workout:vo2/The_Famous_40_20_s');
  check('id is kind + path without extension', w !== undefined);
  check('path keeps the extension', w?.path === 'vo2/The_Famous_40_20_s.zwo', w?.path);
  check('tagged vo2', JSON.stringify(w?.tags) === '["vo2"]');
  const r = route('route:georgia/batumi/batumi_first_ride_');
  check('nested route found', r !== undefined);
  check('tags in path order', JSON.stringify(r?.tags) === '["georgia","batumi"]', JSON.stringify(r?.tags));
  check('top-level file has no tags', JSON.stringify(workout('workout:WO5_Russian_Steps_Speed_Style')?.tags) === '[]');
});

suite('workout entries carry the file\'s details and summary', () => {
  const w = workout('workout:vo2/The_Famous_40_20_s')!;
  check('title from <name>', w.title === "The Famous 40/20's", w.title);
  check('author', w.author === 'M.De Jode (TK.be)');
  check('description', w.description?.startsWith('According to') === true);
  check('pace="0" does not matter: one hour', w.duration === 3600, String(w.duration));
  check('IntervalsT expanded into blocks', w.blocks.length === 1 + 24 + 1 + 24 + 1 + 12 + 1, String(w.blocks.length));
  check('scored', w.tss > 0 && w.if > 0);

  const r = workout('workout:WO5_Russian_Steps_Speed_Style')!;
  check('PowerLow on SteadyState is the target', r.blocks[1][1] === 0.6 && r.blocks[2][1] === 0.5,
    JSON.stringify(r.blocks));
  check('Russian Steps duration', r.duration === 1200);
  check('description keeps its line breaks', r.description?.includes('\n\n15 sec') === true);

  check('no <name>: title from the file name', workout('workout:my_easy-spin')?.title === 'my easy spin',
    workout('workout:my_easy-spin')?.title);
  check('no author or description: fields left out', !('author' in workout('workout:my_easy-spin')!)
    && !('description' in workout('workout:my_easy-spin')!));
});

suite('route entries carry their name and summary', () => {
  const r = route('route:georgia/batumi/batumi_first_ride_')!;
  check('Cyrillic name unchanged', r.name === 'исследуем ближайшие холмы', r.name);
  check('distance and ascent present', r.distance > 0 && r.ascent >= 0);
  check('start position', r.start[0] === 41.635715 && r.start[1] === 41.606202, JSON.stringify(r.start));
});

suite('broken and misplaced files are reported, not fatal', () => {
  check('truncated XML failed, with the parser\'s reason',
    problem('workouts/broken.zwo')?.kind === 'failed' && /XML/i.test(problem('workouts/broken.zwo')!.reason),
    JSON.stringify(problem('workouts/broken.zwo')));
  check('a .gpx in workouts/ skipped', problem('workouts/wrong-place.gpx')?.kind === 'skipped');
  check('a .json in workouts/ skipped', problem('workouts/notes.json')?.kind === 'skipped');
  check('a file outside the kind folders skipped', problem('README.md')?.kind === 'skipped');
  check('a one-point route failed', problem('routes/one-point.gpx')?.kind === 'failed');
  check('dot-files neither listed nor reported', !problems.some((p) => p.path.includes('.DS_Store')));
  check('dot-folders neither listed nor reported', !problems.some((p) => p.path.includes('.hidden'))
    && index.routes.length === 2);
});

suite('files are published under their content hash', () => {
  const w = workout('workout:vo2/The_Famous_40_20_s')!;
  check('key is files/<sha256>.<ext>', /^files\/[0-9a-f]{64}\.zwo$/.test(w.file.key), w.file.key);
  check('key carries the hash', w.file.key === `files/${w.file.sha256}.zwo`);
  check('size is the byte length', w.file.size === enc(FORTY_TWENTY).byteLength);
  check('every listed file is published', [...index.workouts, ...index.routes].every((e) => files.some((f) => f.key === e.file.key)));
  check('content types', files.find((f) => f.key === w.file.key)?.contentType === 'application/xml'
    && files.find((f) => f.key.endsWith('.gpx'))?.contentType === 'application/gpx+xml');
  check('failed files are not published', files.length === 5, String(files.length));
});

const twice = await buildCatalog([file('workouts/a.zwo', RUSSIAN_STEPS), file('workouts/b/a-copy.zwo', RUSSIAN_STEPS)], NOW);
const edited = await buildCatalog([file('workouts/a.zwo', RUSSIAN_STEPS.replace('540', '600'))], NOW);
const again = await buildCatalog([file('workouts/a.zwo', RUSSIAN_STEPS), file('workouts/b/a-copy.zwo', RUSSIAN_STEPS)], NOW);

suite('identical bytes share a key; edited bytes get a new one', () => {
  check('identical bytes: one key, published once',
    twice.index.workouts[0].file.key === twice.index.workouts[1].file.key && twice.files.length === 1);
  check('edited file keeps its id', edited.index.workouts[0].id === 'workout:a');
  check('edited file gets a new key', edited.index.workouts[0].file.key !== twice.index.workouts[0].file.key);
  check('rebuilding unchanged content gives the same index',
    JSON.stringify(again.index) === JSON.stringify(twice.index));
});

const collide = await buildCatalog([
  file('routes/loop.gpx', CYRILLIC_GPX),
  { path: 'routes/loop.fit', bytes: new Uint8Array([14, 16, 0, 0]) },
  file('workouts/a.zwo', RUSSIAN_STEPS),
], NOW);

suite('two files with the same id fail the build, naming both', () => {
  check('one error', collide.errors.length === 1, collide.errors.join('; '));
  check('names both files', collide.errors[0]?.includes('routes/loop.gpx') && collide.errors[0]?.includes('routes/loop.fit'));
  check('neither is listed', collide.index.routes.length === 0);
  check('the rest still builds', collide.index.workouts.length === 1);
});

report();
