// jsdom does not apply the stylesheet's sizes, so the rules the tile layout
// depends on are checked in the stylesheet itself.
const { readFileSync } = await import('node:fs');
const { check, report, suite } = await import('./harness');

const css = readFileSync('src/styles.css', 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  const out: Record<string, string> = {};
  for (const decl of (match?.[1] ?? '').split(';')) {
    const [prop, ...rest] = decl.split(':');
    if (prop.trim()) out[prop.trim()] = rest.join(':').trim();
  }
  return out;
}
const px = (value: string | undefined) => Number(/^(\d+(?:\.\d+)?)px$/.exec(value ?? '')?.[1] ?? NaN);

suite('secondary numbers are large', () => {
  const numbers = rule('.tile .tile-sub b');
  check('the numbers are at least 20 px', px(numbers['font-size']) >= 20, numbers['font-size']);
  check('and bold', Number(numbers['font-weight']) >= 700, numbers['font-weight']);
  const words = rule('.tile .tile-sub');
  check('the words stay at least 13 px', px(words['font-size']) >= 13, words['font-size']);
  check('a row never wraps', words['white-space'] === 'nowrap');
});

suite('value left, two rows right', () => {
  const body = rule('.tile .tile-body');
  check('the body is a row', body.display === 'flex' && body['justify-content'] === 'space-between',
    JSON.stringify(body));
  check('the value is centred in the height under the label', body['align-items'] === 'center' && body.flex === '1');
  const side = rule('.tile .tile-side');
  check('the right column stacks its rows, right-aligned', side['flex-direction'] === 'column' && side['align-items'] === 'flex-end');
  check('and is cut off rather than pushing the value', side.overflow === 'hidden' && side['min-width'] === '0');
  check('the value never shrinks or wraps', rule('.tile .tile-value').flex === 'none'
    && rule('.tile .tile-value')['white-space'] === 'nowrap');
  check('tiles are size containers', rule('.tile')['container-type'] === 'inline-size');
  check('main values are up to 44 px, shrinking with the tile',
    rule('.tile .tile-value')['font-size'] === 'clamp(34px, 20cqi, 44px)', rule('.tile .tile-value')['font-size']);
});

suite('the Elapsed timer matches the other main values', () => {
  check('it has no size of its own', rule('.tile.tile-hero .tile-value')['font-size'] === undefined);
  // "3:59:59": 7 characters at ~0.6 em less 1 px letter-spacing each, at the
  // 44 px cap, in the content box of the narrowest tile (212 px less 26 px).
  const content = 212 - 26;
  check('the timer fits the narrowest tile', 7 * 0.6 * 44 - 7 <= content, `${(7 * 0.6 * 44 - 7).toFixed(0)} px of ${content}`);
  check('and is centred', rule('.tile.tile-hero .tile-body')['justify-content'] === 'center');
});

suite('the tile grid', () => {
  const grid = rule('.metrics')['grid-template-columns'] ?? '';
  const min = px(/minmax\((\d+px)/.exec(grid)?.[1]);
  check('columns are at least 212 px', min >= 212, grid);
});

report();
