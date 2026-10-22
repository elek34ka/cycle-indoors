import type { Segment, TextEvent, Workout } from './types';

/** Zwift .zwo powers are fractions of FTP. A few generators emit absolute watts
 *  instead; anything above this is treated as watts and normalised with the
 *  rider's FTP. (6.0 x FTP would be a ~1300 W block — not a real target.) */
const FRACTION_CEILING = 6;

interface ParseContext { ftp: number; }

function num(el: Element, ...names: string[]): number | undefined {
  for (const n of names) {
    const raw = el.getAttribute(n);
    if (raw === null) continue;
    const v = Number.parseFloat(raw);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

function power(el: Element, ctx: ParseContext, ...names: string[]): number | undefined {
  const v = num(el, ...names);
  if (v === undefined) return undefined;
  return v > FRACTION_CEILING ? v / ctx.ftp : v;
}

function text(doc: Document, tag: string): string | undefined {
  const el = doc.querySelector(tag);
  const value = el?.textContent?.trim();
  return value ? value : undefined;
}

function pctLabel(from?: number, to?: number): string {
  if (from === undefined) return 'Free ride';
  const a = Math.round(from * 100);
  if (to === undefined || Math.round(to * 100) === a) return `${a}% FTP`;
  return `${a} → ${Math.round(to * 100)}% FTP`;
}

export function parseZwo(xml: string, ctx: ParseContext): Workout {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(`Not valid XML: ${error.textContent?.slice(0, 200)}`);
  const root = doc.querySelector('workout_file');
  if (!root) throw new Error('Missing <workout_file> root — is this a Zwift workout?');
  const blocks = doc.querySelector('workout');
  if (!blocks) throw new Error('Missing <workout> block list');

  const segments: Segment[] = [];
  const textEvents: TextEvent[] = [];
  let cursor = 0;

  const push = (opts: Omit<Segment, 'index' | 'start' | 'label'> & { label?: string }) => {
    const seg: Segment = {
      index: segments.length,
      start: cursor,
      label: opts.label ?? pctLabel(opts.powerStart, opts.powerEnd),
      ...opts,
    };
    segments.push(seg);
    cursor += seg.duration;
    return seg;
  };

  const collectTextEvents = (el: Element, blockStart: number) => {
    for (const te of Array.from(el.getElementsByTagName('textevent'))) {
      const message = te.getAttribute('message')?.trim();
      if (!message) continue;
      textEvents.push({
        time: blockStart + (num(te, 'timeoffset') ?? 0),
        duration: num(te, 'duration') ?? 10,
        message,
      });
    }
  };

  for (const el of Array.from(blocks.children)) {
    const tag = el.tagName;
    const blockStart = cursor;
    const cadence = num(el, 'Cadence', 'cadence');

    switch (tag) {
      case 'Warmup':
      case 'Ramp':
      case 'Cooldown': {
        const duration = num(el, 'Duration') ?? 0;
        let from = power(el, ctx, 'PowerLow', 'Power') ?? 0.5;
        let to = power(el, ctx, 'PowerHigh') ?? from;
        // Exporters disagree on attribute order for cooldowns; a cooldown always descends.
        if (tag === 'Cooldown' && to > from) [from, to] = [to, from];
        push({ duration, powerStart: from, powerEnd: to, cadence, mode: 'erg', kind: tag });
        break;
      }
      case 'SteadyState': {
        const duration = num(el, 'Duration') ?? 0;
        const p = power(el, ctx, 'Power', 'PowerLow') ?? 0.6;
        push({ duration, powerStart: p, powerEnd: p, cadence, mode: 'erg', kind: tag });
        break;
      }
      case 'IntervalsT': {
        const repeat = Math.max(1, Math.round(num(el, 'Repeat') ?? 1));
        const onDuration = num(el, 'OnDuration') ?? 0;
        const offDuration = num(el, 'OffDuration') ?? 0;
        const onPower = power(el, ctx, 'OnPower', 'PowerOnHigh', 'PowerOnLow') ?? 1;
        const offPower = power(el, ctx, 'OffPower', 'PowerOffHigh', 'PowerOffLow') ?? 0.5;
        const onCadence = num(el, 'Cadence', 'CadenceOn') ?? cadence;
        const offCadence = num(el, 'CadenceResting', 'CadenceOff');
        for (let r = 0; r < repeat; r++) {
          if (onDuration > 0) push({
            duration: onDuration, powerStart: onPower, powerEnd: onPower, cadence: onCadence,
            mode: 'erg', kind: 'IntervalOn', name: `${r + 1}/${repeat}`, label: `${r + 1}/${repeat} · ${Math.round(onPower * 100)}% FTP`,
          });
          if (offDuration > 0) push({
            duration: offDuration, powerStart: offPower, powerEnd: offPower, cadence: offCadence,
            mode: 'erg', kind: 'IntervalOff', name: 'Recover', label: `Recover · ${Math.round(offPower * 100)}% FTP`,
          });
        }
        break;
      }
      case 'FreeRide':
      case 'SolidState': {
        const duration = num(el, 'Duration') ?? 0;
        push({ duration, cadence, mode: 'free', kind: 'FreeRide', label: 'Free ride' });
        break;
      }
      case 'MaxEffort': {
        const duration = num(el, 'Duration') ?? 0;
        push({ duration, cadence, mode: 'free', kind: 'MaxEffort', label: 'Max effort' });
        break;
      }
      case 'textevent': {
        // Rare: a message pinned to the workout timeline rather than to a block.
        const message = el.getAttribute('message')?.trim();
        if (message) textEvents.push({ time: num(el, 'timeoffset') ?? cursor, duration: num(el, 'duration') ?? 10, message });
        continue;
      }
      default:
        // Unknown block with a duration: keep the timeline honest rather than drop time.
        if (num(el, 'Duration') !== undefined) {
          push({ duration: num(el, 'Duration')!, cadence, mode: 'free', kind: tag, label: tag });
        }
        break;
    }
    collectTextEvents(el, blockStart);
  }

  if (segments.length === 0) throw new Error('Workout contains no usable blocks');

  return {
    name: text(doc, 'name') ?? 'Untitled workout',
    author: text(doc, 'author'),
    description: text(doc, 'description'),
    sport: text(doc, 'sportType') ?? 'bike',
    duration: cursor,
    segments,
    textEvents: textEvents.sort((a, b) => a.time - b.time),
    source: 'zwo',
  };
}
