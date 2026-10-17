import { finaliseTrack, type ActivityTrack, type TrackPoint } from './types';

function firstNumber(el: Element, ...localNames: string[]): number | undefined {
  for (const name of localNames) {
    // GPX extensions live in several namespaces (gpxtpx, ns3, pwr...), so match on local name.
    const found = Array.from(el.getElementsByTagName('*')).find(
      (child) => child.localName.toLowerCase() === name.toLowerCase(),
    );
    const raw = found?.textContent?.trim();
    if (raw) {
      const v = Number.parseFloat(raw);
      if (Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

export function parseGpx(xml: string, fallbackName: string): ActivityTrack {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`Not valid XML: ${err.textContent?.slice(0, 200)}`);

  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (nodes.length === 0) nodes = Array.from(doc.getElementsByTagName('rtept'));
  if (nodes.length === 0) nodes = Array.from(doc.getElementsByTagName('wpt'));
  if (nodes.length === 0) throw new Error('No <trkpt>, <rtept> or <wpt> points found in this GPX file');

  const points: TrackPoint[] = [];
  for (const node of nodes) {
    const lat = Number.parseFloat(node.getAttribute('lat') ?? '');
    const lon = Number.parseFloat(node.getAttribute('lon') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const timeText = Array.from(node.getElementsByTagName('*'))
      .find((c) => c.localName === 'time')?.textContent?.trim();
    const parsed = timeText ? Date.parse(timeText) : NaN;
    points.push({
      lat,
      lon,
      ele: firstNumber(node, 'ele'),
      time: Number.isFinite(parsed) ? parsed : undefined,
      distance: 0,
      hr: firstNumber(node, 'hr', 'heartrate'),
      cadence: firstNumber(node, 'cad', 'cadence'),
      power: firstNumber(node, 'power', 'PowerInWatts', 'watts'),
      speed: firstNumber(node, 'speed'),
    });
  }
  if (points.length === 0) throw new Error('GPX points had no usable coordinates');

  const nameEl = doc.querySelector('trk > name') ?? doc.querySelector('metadata > name') ?? doc.querySelector('name');
  const name = nameEl?.textContent?.trim() || fallbackName;
  return finaliseTrack(name, 'gpx', points);
}
