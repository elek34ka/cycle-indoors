import type * as LeafletNS from 'leaflet';
import { nearestDistance, type GradientRun, type LatLon } from '../activity/route-geometry';
import { clear, el } from './dom';

const LINE_CASING = '#13263d';
/** Wide enough to catch a pointer that is near the line, not exactly on it. */
const HIT_WEIGHT = 16;

type Leaflet = typeof LeafletNS;

async function importLeaflet(): Promise<Leaflet> {
  const [leaflet] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
  return leaflet.default ?? (leaflet as unknown as Leaflet);
}

export interface RoutePreviewMapOptions {
  /** How Leaflet is fetched; replaced in tests to simulate being offline. */
  loadLeaflet?: () => Promise<Leaflet>;
}

/**
 * The route smoother's map: the loaded route coloured by smoothed gradient,
 * with a marker for whatever distance is hovered. Unlike the ride screen's
 * mini map it never follows anything, so it keeps whatever view the rider
 * leaves it at. Leaflet is fetched by the first `setRoute`, not before.
 */
export class RoutePreviewMap {
  /** Called with the distance along the route nearest the pointer while it is
   *  over the line, and with undefined when it leaves. */
  onHover: (distance: number | undefined) => void = () => {};

  private readonly loadLeaflet: () => Promise<Leaflet>;
  private readonly mapHost: HTMLElement;
  private readonly tileNotice: HTMLElement;
  private L: Leaflet | undefined;
  private map: LeafletNS.Map | undefined;
  private tileLayer: LeafletNS.TileLayer | undefined;
  private loading: Promise<void> | undefined;
  private failed = false;

  private points: LatLon[] = [];
  private distances: number[] = [];
  private runs: GradientRun[] = [];
  /** set by setRoute, cleared once the new route has been drawn and framed */
  private routePending = false;

  private casing: LeafletNS.Polyline | undefined;
  /** the end markers and the hit line, which must stay above the coloured runs */
  private overlays: LeafletNS.Path[] = [];
  private runLayer: LeafletNS.LayerGroup | undefined;
  private hoverMarker: LeafletNS.CircleMarker | undefined;
  private hoverPosition: LatLon | undefined;
  private pointer: LeafletNS.LatLng | undefined;
  private raf = 0;

  constructor(private readonly host: HTMLElement, options: RoutePreviewMapOptions = {}) {
    this.loadLeaflet = options.loadLeaflet ?? importLeaflet;
    this.mapHost = el('div', { class: 'smoother-map-canvas' });
    this.tileNotice = el('div', { class: 'smoother-map-notice', text: 'Map tiles unavailable' });
    this.tileNotice.hidden = true;
    host.append(this.mapHost, this.tileNotice);
    new ResizeObserver(() => this.map?.invalidateSize()).observe(host);
  }

  /** A new route: redraw everything and frame it. */
  setRoute(points: LatLon[], distances: number[], runs: GradientRun[]): Promise<void> {
    this.points = points;
    this.distances = distances;
    this.runs = runs;
    this.hoverPosition = undefined;
    this.routePending = true;
    return this.ensureMap().then(() => this.drawRoute());
  }

  /** The same route recoloured: only the coloured lines change, the view stays. */
  setColours(runs: GradientRun[]): void {
    this.runs = runs;
    if (!this.routePending) this.drawRuns();
  }

  setHover(position: LatLon | undefined): void {
    this.hoverPosition = position;
    this.drawHover();
  }

  /** What hovering the line at `lat`/`lon` does; the line's own listener calls this. */
  hoverAt(lat: number | undefined, lon?: number): void {
    if (lat === undefined || lon === undefined || this.points.length < 2) {
      this.onHover(undefined);
      return;
    }
    this.onHover(nearestDistance(this.points, this.distances, lat, lon));
  }

  /** Where the map is looking and what it shows. Read-only, for tests. */
  get viewState(): {
    lat: number; lon: number; zoom: number;
    bounds: { south: number; west: number; north: number; east: number };
    runs: number; hover?: LatLon;
  } | undefined {
    if (!this.map) return undefined;
    const centre = this.map.getCenter();
    const b = this.map.getBounds();
    return {
      lat: centre.lat,
      lon: centre.lng,
      zoom: this.map.getZoom(),
      bounds: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
      runs: this.runLayer?.getLayers().length ?? 0,
      hover: this.hoverMarker ? { lat: this.hoverMarker.getLatLng().lat, lon: this.hoverMarker.getLatLng().lng } : undefined,
    };
  }

  /** The OSM tile layer, so a test can fire its events. */
  get tiles(): LeafletNS.TileLayer | undefined { return this.tileLayer; }

  // ---- map -----------------------------------------------------------------

  private async ensureMap(): Promise<void> {
    if (this.map || this.failed) return;
    this.loading ??= (async () => {
      let L: Leaflet;
      try {
        L = await this.loadLeaflet();
      } catch {
        // Offline, most likely. Everything else in the smoother carries on.
        this.failed = true;
        clear(this.host);
        this.host.append(el('div', { class: 'smoother-map-unavailable', text: 'Map unavailable — check your connection' }));
        return;
      }
      this.L = L;
      // SVG renderer, as on the mini map: a canvas layer visibly shifts
      // against the tiles while the map pans.
      const map = L.map(this.mapHost, { zoomControl: false, attributionControl: true }).setView([50.06, 19.94], 13);
      this.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      this.tileLayer.on('tileerror', () => { this.tileNotice.hidden = false; });
      this.tileLayer.on('tileload', () => { this.tileNotice.hidden = true; });
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      this.map = map;
    })();
    await this.loading;
  }

  private drawRoute(): void {
    const L = this.L;
    const map = this.map;
    if (!L || !map) return;
    this.casing?.remove();
    this.runLayer?.remove();
    for (const layer of this.overlays) layer.remove();
    this.casing = undefined;
    this.runLayer = undefined;
    this.overlays = [];
    this.routePending = false;
    if (this.points.length < 2) return;

    const latlngs = this.points.map((p) => [p.lat, p.lon] as LeafletNS.LatLngTuple);
    this.casing = L.polyline(latlngs, {
      color: LINE_CASING, weight: 7, opacity: 0.9, lineJoin: 'round', interactive: false,
    }).addTo(map);
    this.drawRuns();

    const end = (at: LeafletNS.LatLngTuple, fill: string) =>
      L.circleMarker(at, { radius: 5, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 1, interactive: false });
    const hit = L.polyline(latlngs, { color: '#000', weight: HIT_WEIGHT, opacity: 0 });
    hit.on('mousemove', (e: LeafletNS.LeafletMouseEvent) => this.queueHover(e.latlng));
    hit.on('mouseout', () => this.queueHover(undefined));
    // Finish first, so on a loop the start marker is the one on top.
    this.overlays = [end(latlngs[latlngs.length - 1], '#e4563c'), end(latlngs[0], '#3fc07a'), hit];
    for (const layer of this.overlays) layer.addTo(map);
    this.drawHover();

    map.invalidateSize();
    map.fitBounds(L.latLngBounds(latlngs).pad(0.1));
  }

  private drawRuns(): void {
    const L = this.L;
    const map = this.map;
    if (!L || !map || this.points.length < 2) return;
    this.runLayer?.remove();
    this.runLayer = L.layerGroup(this.runs.map((run) =>
      L.polyline(run.latlngs, { color: run.color, weight: 4, opacity: 1, lineJoin: 'round', interactive: false }),
    )).addTo(map);
    // Recoloured lines go on top of everything; put the markers and the hit line back above them.
    for (const layer of this.overlays) layer.bringToFront();
    this.hoverMarker?.bringToFront();
  }

  private drawHover(): void {
    const L = this.L;
    const map = this.map;
    if (!L || !map) return;
    const at = this.hoverPosition;
    if (!at) {
      this.hoverMarker?.remove();
      this.hoverMarker = undefined;
      return;
    }
    if (this.hoverMarker) this.hoverMarker.setLatLng([at.lat, at.lon]);
    else {
      this.hoverMarker = L.circleMarker([at.lat, at.lon], {
        radius: 6, color: '#0b0e13', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false,
      }).addTo(map);
    }
  }

  /** At most one nearest-point search per frame, however fast the mouse moves. */
  private queueHover(latlng: LeafletNS.LatLng | undefined): void {
    this.pointer = latlng;
    if (!latlng) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.hoverAt(undefined);
      return;
    }
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.pointer) this.hoverAt(this.pointer.lat, this.pointer.lng);
    });
  }
}
