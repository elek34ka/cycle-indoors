const { palette, landColour, SEASONS, SCENERY_PARTS } = await import('../src/scene/palette');
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
    let badFar = 0;
    for (let r = 0; r <= 1.0001; r += 0.05) if (!valid(pal.far(r))) badFar++;
    check('the far tint is valid from low to high ground', badFar === 0);
    const missingParts = SCENERY_PARTS.filter((k) => !valid(pal.scenery[k]));
    check('every scenery part has a colour in [0, 1]', missingParts.length === 0, missingParts.join(', '));
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

report();
