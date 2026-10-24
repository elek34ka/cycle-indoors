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

suite('tile averages are large', () => {
  const numbers = rule('.tile .tile-sub b');
  check('the numbers are at least 20 px', px(numbers['font-size']) >= 20, numbers['font-size']);
  check('and bold', Number(numbers['font-weight']) >= 700, numbers['font-weight']);
  const labels = rule('.tile .tile-sub');
  check('the labels stay at least 13 px', px(labels['font-size']) >= 13, labels['font-size']);
  check('the averages line does not wrap', rule('.tile .tile-sub.has-parts')['white-space'] === 'nowrap');
});

suite('the tile grid', () => {
  const grid = rule('.metrics')['grid-template-columns'] ?? '';
  const min = px(/minmax\((\d+px)/.exec(grid)?.[1]);
  check('columns are at least 196 px', min >= 196, grid);
});

suite('the Cadence/Speed cell fits the row', () => {
  const stack = rule('.tile-stack');
  check('two equal rows', stack['grid-template-rows'] === '1fr 1fr', stack['grid-template-rows']);
  const value = rule('.tile.tile-compact .tile-value');
  const compact = rule('.tile.tile-compact');
  const pad = (compact.padding ?? '').split(/\s+/).map(px);
  // One full tile: 9 + 10 px padding, 2 px border, a 12 px label (~15 px line),
  // the 40 px value at 1.12 and the 20 px averages at 1.2.
  const fullTile = 9 + 10 + 2 + 15 + 40 * 1.12 + 20 * 1.2;
  const half = 2 * pad[0] + 2 + px(value['font-size']) * Number(value['line-height']);
  const stacked = 2 * half + px(stack.gap);
  check('two compact tiles and the gap are no taller than a full tile', stacked <= fullTile,
    `${stacked.toFixed(1)} px vs ${fullTile.toFixed(1)} px`);
});

report();
