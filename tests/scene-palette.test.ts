const { palette, landColour, flowerPart, bare, SEASONS, SCENERY_PARTS, DETAIL_PARTS, DEFAULT_SEASON, DEFAULT_PALETTE } = await import('../src/scene/palette');
const { SCENERY_KINDS } = await import('../src/scene/scenery');
const { readFileSync, readdirSync } = await import('node:fs');
const { LAND_KINDS } = await import('../src/scene/landscape');
const { check, report, suite } = await import('./harness');
import type { RGB } from '../src/scene/palette';

const valid = (c: RGB | undefined) => !!c && c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);

for (const season of SEASONS) {
  suite(`palette: ${season}`, () => {
    const pal = palette(season);
    check('it is the season asked for', pal.season === season);
    const missingLand = LAND_KINDS.filter((k) => !valid(pal.ground[k]));
    check('every kind of land has a ground colour in [0, 1]', missingLand.length === 0, missingLand.join(', '));
    check('farmland has a valid band colour', valid(pal.farmlandBand));
    check('water has a valid colour', valid(pal.water));
    check('the road\'s asphalt, gravel and paint have valid colours', valid(pal.road.asphalt) && valid(pal.road.gravel) && valid(pal.road.paint));
    let badFar = 0;
    for (let r = 0; r <= 1.0001; r += 0.05) if (!valid(pal.far(r))) badFar++;
    check('the far tint is valid from low to high ground', badFar === 0);
    const missingParts = SCENERY_PARTS.filter((k) => !valid(pal.scenery[k]));
    check('every scenery part has a colour in [0, 1]', missingParts.length === 0, missingParts.join(', '));
    const missingDetails = DETAIL_PARTS.filter((k) => !valid(pal.details[k]));
    check('every ground detail part has a colour in [0, 1]', missingDetails.length === 0, missingDetails.join(', '));
    // one kind's weight alone gives exactly that kind's colour; the band changes only farmland
    let wrong = 0;
    LAND_KINDS.forEach((kind, k) => {
      const w = new Float32Array(LAND_KINDS.length);
      w[k] = 1;
      const plain = landColour(pal, w, 0);
      const banded = landColour(pal, w, 1);
      if (plain.some((v, ch) => Math.abs(v - pal.ground[kind][ch]) > 1e-6)) wrong++;
      const expect = kind === 'farmland' ? pal.farmlandBand : pal.ground[kind];
      if (banded.some((v, ch) => Math.abs(v - expect[ch]) > 1e-6)) wrong++;
    });
    check('a single kind\'s weight gives its own colour, and only farmland shows bands', wrong === 0, `${wrong}`);
    const distinct = new Set(LAND_KINDS.map((k) => pal.ground[k].join()));
    check('every kind of land has its own colour', distinct.size === LAND_KINDS.length);
  });
}

suite('palette: the seasons', () => {
  check(`there are four seasons (${SEASONS.join(', ')}), and the window opens in summer`, SEASONS.length === 4 && DEFAULT_SEASON === 'summer' && DEFAULT_PALETTE === palette('summer'));
  const summer = palette('summer');
  const winter = palette('winter');
  const same = (a: number[], b: number[]) => a.every((v, k) => v === b[k]);
  let roadDiffers = 0;
  for (const season of SEASONS) {
    const r = palette(season).road;
    if (!same(r.asphalt, summer.road.asphalt) || !same(r.gravel, summer.road.gravel) || !same(r.paint, summer.road.paint)) roadDiffers++;
  }
  check('the road, its gravel shoulder and its paint are the same in every season, so winter keeps the road clear', roadDiffers === 0, `${roadDiffers}`);
  // snow: every kind of land is pale in winter, and far paler than in summer
  const light = (c: number[]) => (c[0] + c[1] + c[2]) / 3;
  const notSnow = Object.entries(winter.ground).filter(([k, c]) => light(c) < 0.8 || light(c) < light(summer.ground[k as keyof typeof summer.ground]) + 0.3).map(([k]) => k);
  check('in winter every kind of land and the far land are snow', notSnow.length === 0 && light(winter.far(0)) >= 0.8 && light(winter.far(1)) >= 0.8, notSnow.join(', '));
  check('in winter the ponds are ice: pale, not summer\'s water', light(winter.water) >= 0.75 && !same(winter.water, summer.water));
  // autumn crowns: yellow, orange and red among the broadleaf kinds
  const hue = (c: number[]) => {
    const [r, g, b] = c;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    const h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    return (h * 60 + 360) % 360;
  };
  const autumn = palette('autumn').scenery;
  const crowns = (['leaves', 'oak', 'birch', 'poplar'] as const).map((k) => hue(autumn[k]));
  const has = (lo: number, hi: number) => crowns.some((h) => h >= lo && h < hi);
  check(`autumn crowns are red, orange and yellow (hues ${crowns.map((h) => h.toFixed(0)).join(', ')}°)`, has(0, 20) && has(20, 42) && has(42, 65));
  check('autumn\'s conifers keep summer\'s needles', same(autumn.pine, summer.scenery.pine) && same(autumn.spruce, summer.scenery.spruce));
  const spring = palette('spring');
  const greener = (['fields', 'meadow'] as const).every((k) => spring.ground[k][1] > summer.ground[k][1]);
  check('spring\'s fields and meadow are a fresher green than summer\'s', greener);
  // which trees are bare
  const wrong: string[] = [];
  for (const season of SEASONS) {
    for (const kind of SCENERY_KINDS) {
      const want = season === 'winter' && ['broadleaf', 'oak', 'birch', 'poplar'].includes(kind);
      if (bare(kind, season) !== want) wrong.push(`${kind} in ${season}`);
    }
  }
  check('broadleaf, oak, birch and poplar are bare in winter only; conifers, bushes, rocks and posts never', wrong.length === 0, wrong.join(', '));
  check('pine and spruce are never bare', SEASONS.every((s) => !bare('pine', s) && !bare('spruce', s)));
});

suite('palette: no placement reads the season', () => {
  // the season changes colours only: nothing outside the drawing code may read
  // the palette, so every tree, rock, pond and detail stands where it did
  const readers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.ts')).filter((f) => /from '\.\.?\/(\.\.\/)?palette'/.test(readFileSync(`${dir}/${f}`, 'utf8'))).map((f) => `${dir}/${f}`);
  const found = [...readers('src/scene'), ...readers('src/scene/mesh'), ...readers('src/scene/render')].sort();
  // render/types.ts names the Season type in the renderer's interface
  const allowed = ['src/scene/mesh/road-mesh.ts', 'src/scene/mesh/terrain-mesh.ts', 'src/scene/render/scene-renderer.ts', 'src/scene/render/types.ts'];
  check(`only the mesh builders and the renderer (and its interface) read the palette (${found.join(', ')})`, found.every((f) => allowed.includes(f)), found.filter((f) => !allowed.includes(f)).join(', '));
  const placement = ['scenery', 'details', 'ponds', 'ground', 'landscape', 'passes'].map((m) => readFileSync(`src/scene/${m}.ts`, 'utf8'));
  check('no placement module takes a season or a palette', placement.every((src) => !/\bSeason\b|\bPalette\b|palette\(/.test(src)));
});

suite('palette: flowers', () => {
  const seen = new Set<string>();
  for (let t = 0; t < 1; t += 0.01) seen.add(flowerPart(t));
  check(`a flower's tint picks one of three flower colours (${[...seen].join(', ')})`, seen.size === 3 && [...seen].every((k) => k.startsWith('flower')));
});

report();
