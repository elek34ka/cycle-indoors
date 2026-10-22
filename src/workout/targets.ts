import type { Segment } from './types';

/** A block's target at both ends, rounded the way it is shown: whole watts and
 *  whole percent. `ramp` only when both differ, so a near-flat ramp reads as steady. */
function ends(seg: Segment, ftp: number) {
  if (seg.powerStart === undefined) return undefined;
  const end = seg.powerEnd ?? seg.powerStart;
  const watts = [Math.round(seg.powerStart * ftp), Math.round(end * ftp)] as const;
  const pct = [Math.round(seg.powerStart * 100), Math.round(end * 100)] as const;
  return { watts, pct, ramp: watts[0] !== watts[1] && pct[0] !== pct[1] };
}

/** "180–240 W" for a ramp (in the direction it runs), "225 W" for a steady block. */
export function wattsText(seg: Segment, ftp: number): string | undefined {
  const e = ends(seg, ftp);
  if (!e) return undefined;
  return e.ramp ? `${e.watts[0]}–${e.watts[1]} W` : `${e.watts[0]} W`;
}

/** "180–240 W (60–80%)" or "225 W (75%)"; undefined for a free-ride block. */
export function targetText(seg: Segment, ftp: number): string | undefined {
  const e = ends(seg, ftp);
  if (!e) return undefined;
  return e.ramp
    ? `${e.watts[0]}–${e.watts[1]} W (${e.pct[0]}–${e.pct[1]}%)`
    : `${e.watts[0]} W (${e.pct[0]}%)`;
}

/** What the rider reads for a block: its name, if any, then its target in
 *  watts and percent. Free-ride blocks keep the label the file gave them. */
export function blockLabel(seg: Segment, ftp: number): string {
  const target = targetText(seg, ftp);
  if (target === undefined) return seg.label;
  return seg.name ? `${seg.name} · ${target}` : target;
}
