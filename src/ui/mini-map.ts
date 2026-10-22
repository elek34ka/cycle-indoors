import type * as LeafletNS from 'leaflet';
import type { Course } from '../activity/course';
import { haversine } from '../activity/types';
import { settings } from '../core/settings';
import { el } from './dom';

const LINE_CASING = '#13263d';
const LINE_COLOR = '#1f6feb';
/** Close enough to see the next corner coming, as Zwift's minimap does. */
const FOLLOW_ZOOM = 16;
/** Time constant for easing the drawn position toward the real one. Damps the
 *  speed noise that every trainer produces without adding visible lag. */
const SMOOTH_TAU = 0.3;
/** A jump bigger than this is a lap wrap or a seek, not riding — go straight
 *  there instead of gliding across the map. */
const SNAP_METRES = 150;
/** The map only moves once the rider drifts this far from the middle, as a
 *  fraction of the smaller viewport dimension. Constant panning reads as jitter. */
const DEAD_ZONE_FRACTION = 0.12;
const DEAD_ZONE_MIN_PX = 18;
/** Pan animation length, and the minimum gap between pans so they never stack. */
const PAN_SECONDS = 0.9;
/** A press on the title bar becomes a drag only after this much movement, so a
 *  click or double-click never unpins the map from its corner. */
const DRAG_THRESHOLD_PX = 3;

export interface PanelPosition { left: number; top: number; }

/** Keeps a panel of `size` fully inside `viewport`. One larger than the
 *  viewport is pinned to the top-left, so its title bar stays reachable. */
export function clampToViewport(
  pos: PanelPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): PanelPosition {
  return {
    left: Math.max(0, Math.min(pos.left, viewport.width - size.width)),
    top: Math.max(0, Math.min(pos.top, viewport.height - size.height)),
  };
}

/** A small route map pinned in the corner of the ride screen. Hideable, and
 *  Leaflet is only fetched the first time it is actually shown. */
export class MiniMap {
  private root: HTMLElement;
  private mapHost: HTMLElement;
  private titleNode: HTMLElement;
  private showButton: HTMLButtonElement;
  private followInput: HTMLInputElement | undefined;
  private L: typeof LeafletNS | undefined;
  private map: LeafletNS.Map | undefined;
  private routeLayer: LeafletNS.LayerGroup | undefined;
  private rider: LeafletNS.CircleMarker | undefined;
  private hoverMarker: LeafletNS.CircleMarker | undefined;
  private course: Course | undefined;
  private loading: Promise<void> | undefined;
  /** There is nothing to show without a route, so the map is not offered at
   *  all until one is loaded — and Leaflet is never even fetched. */
  private enabled = false;

  /** where the rider actually is */
  private target: { lat: number; lon: number } | undefined;
  /** where the marker is drawn — eased toward the target */
  private shown: { lat: number; lon: number } | undefined;
  private raf: number | undefined;
  private lastFrame: number | undefined;
  private lastPanAt = 0;
  /** where the rider dragged the panel; undefined while it sits in its corner */
  private position: PanelPosition | undefined;

  constructor(host: HTMLElement) {
    this.titleNode = el('span', { class: 'mini-map-title', text: 'No route' });
    this.mapHost = el('div', { class: 'mini-map-canvas' });
    const head = el('div', { class: 'mini-map-head', title: 'Drag to move · double-click to put back' }, [
      this.titleNode,
      el('button', {
        class: 'mini-map-btn', text: '⤢', title: 'Show the whole route',
        on: { click: () => this.showWholeRoute() },
      }),
      el('button', {
        class: 'mini-map-btn', text: '×', title: 'Hide the map (M)',
        on: { click: () => this.setVisible(false) },
      }),
    ]);
    this.root = el('div', { class: 'mini-map' }, [head, this.mapHost]);

    this.showButton = el('button', {
      class: 'mini-map-show', text: 'Map', title: 'Show the route map (M)',
      on: { click: () => this.setVisible(true) },
    });

    host.append(this.root, this.showButton);
    this.enableDrag(head);
    const saved = settings.current.miniMapPosition;
    if (saved) this.placeAt(saved);
    this.applyEnabled();
  }

  // ---- placement -----------------------------------------------------------

  /**
   * The title bar drags the panel anywhere in the window. The panel stays in
   * the ride view's DOM, only switching to fixed positioning, so it is still
   * hidden with the view. Dragging inside the map pans the map as before.
   */
  private enableDrag(head: HTMLElement): void {
    let press: { x: number; y: number; dx: number; dy: number; moved: boolean } | undefined;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element | null)?.closest('button')) return;
      const rect = this.root.getBoundingClientRect();
      press = { x: e.clientX, y: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
      head.setPointerCapture?.(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!press) return;
      if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return;
      press.moved = true;
      this.root.classList.add('dragging');
      this.placeAt({ left: e.clientX - press.dx, top: e.clientY - press.dy });
    });
    const release = () => {
      const moved = press?.moved;
      press = undefined;
      this.root.classList.remove('dragging');
      // Saved once per drag: a settings patch re-renders the ride view.
      if (moved && this.position) settings.patch({ miniMapPosition: this.position });
    };
    head.addEventListener('pointerup', release);
    head.addEventListener('pointercancel', release);
    head.addEventListener('dblclick', (e) => {
      if (!(e.target as Element | null)?.closest('button')) this.resetPosition();
    });
    window.addEventListener('resize', () => { if (this.position) this.placeAt(this.position); });
  }

  private placeAt(pos: PanelPosition): void {
    const rect = this.root.getBoundingClientRect();
    this.position = clampToViewport(pos, rect, { width: window.innerWidth, height: window.innerHeight });
    this.root.classList.add('floating');
    this.root.style.left = `${this.position.left}px`;
    this.root.style.top = `${this.position.top}px`;
  }

  /** Back to the corner of the workout graph, and forget the dragged position. */
  resetPosition(): void {
    this.position = undefined;
    this.root.classList.remove('floating');
    this.root.style.left = '';
    this.root.style.top = '';
    settings.patch({ miniMapPosition: null });
  }

  // ---- visibility ----------------------------------------------------------

  get available(): boolean { return this.enabled; }

  setVisible(visible: boolean): void {
    if (!this.enabled) return;
    settings.patch({ showMiniMap: visible });
    this.applyVisibility(visible);
  }

  private applyEnabled(): void {
    if (!this.enabled) {
      this.root.classList.add('hidden');
      this.showButton.classList.add('hidden');
      this.stopLoop();
      return;
    }
    this.applyVisibility(settings.current.showMiniMap);
  }

  private get visible(): boolean { return !this.root.classList.contains('hidden'); }

  private applyVisibility(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
    this.showButton.classList.toggle('hidden', visible);
    if (!visible) {
      this.stopLoop();
      return;
    }
    // Measured while hidden it had no size, so check it fits now it has one.
    if (this.position) this.placeAt(this.position);
    void this.ensureMap().then(() => {
      this.map?.invalidateSize();
      this.recentre();
      this.startLoop();
    });
  }

  private get following(): boolean { return settings.current.miniMapFollow; }

  private setFollowing(follow: boolean): void {
    settings.patch({ miniMapFollow: follow });
    if (this.followInput) this.followInput.checked = follow;
    if (follow) this.recentre();
  }

  // ---- map -----------------------------------------------------------------

  private async ensureMap(): Promise<void> {
    if (this.map) return;
    this.loading ??= (async () => {
      const [leaflet] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
      const L = leaflet.default ?? (leaflet as unknown as typeof LeafletNS);
      this.L = L;
      // SVG renderer, not canvas: its layers ride along with the pane's CSS
      // transform during a pan, where the canvas renderer redraws and can be
      // seen shifting against the tiles.
      const map = L.map(this.mapHost, {
        zoomControl: false,
        attributionControl: true,
      }).setView([50.06, 19.94], FOLLOW_ZOOM);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      this.addFollowControl(L, map);

      // Panning by hand means "stop chasing the rider" — and the switch shows it.
      map.on('dragstart', () => { if (this.following) this.setFollowing(false); });
      this.map = map;
      if (this.course) this.drawCourse();
      this.startLoop();
    })();
    await this.loading;
  }

  /** An on/off switch inside the map itself, so following can be turned off
   *  without leaving the ride screen. */
  private addFollowControl(L: typeof LeafletNS, map: LeafletNS.Map): void {
    const control = new L.Control({ position: 'topright' });
    control.onAdd = () => {
      const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = this.following;
      input.addEventListener('change', () => this.setFollowing(input.checked));
      this.followInput = input;
      const wrapper = el('label', {
        class: 'map-switch',
        title: 'Keep the map centred on you as you ride',
      }, [input, el('span', { text: 'Follow' })]);
      L.DomEvent.disableClickPropagation(wrapper);
      L.DomEvent.disableScrollPropagation(wrapper);
      return wrapper;
    };
    control.addTo(map);
  }

  setCourse(course: Course | undefined): void {
    this.course = course;
    this.target = undefined;
    this.shown = undefined;
    this.enabled = course !== undefined;
    this.titleNode.textContent = course ? course.name : 'No route';
    // Clears the old route's layers when the course goes away, draws the new
    // one when it does not. Only possible once Leaflet is actually loaded.
    if (this.map) this.drawCourse();
    this.applyEnabled();
  }

  private drawCourse(): void {
    const L = this.L;
    if (!L || !this.map) return;
    this.routeLayer?.remove();
    this.rider?.remove();
    this.hoverMarker?.remove();
    this.routeLayer = undefined;
    this.rider = undefined;
    this.hoverMarker = undefined;
    if (!this.course) return;

    const latlngs = this.course.points.map((p) => [p.lat, p.lon] as LeafletNS.LatLngTuple);
    this.routeLayer = L.layerGroup([
      L.polyline(latlngs, { color: LINE_CASING, weight: 7, opacity: 0.9, lineJoin: 'round' }),
      L.polyline(latlngs, { color: LINE_COLOR, weight: 3, opacity: 1, lineJoin: 'round' }),
      L.circleMarker(latlngs[0], { radius: 5, color: '#fff', weight: 2, fillColor: '#3fc07a', fillOpacity: 1 }),
    ]).addTo(this.map);
    this.recentre();
  }

  /** Centre on the rider at close zoom when following, else fit the route. */
  private recentre(): void {
    if (!this.map || !this.course) return;
    if (!this.following) {
      this.showWholeRoute();
      return;
    }
    const point = this.shown ?? this.target ?? this.course.points[0];
    this.map.setView([point.lat, point.lon], Math.max(this.map.getZoom(), FOLLOW_ZOOM), { animate: false });
    this.lastPanAt = performance.now();
  }

  showWholeRoute(): void {
    const L = this.L;
    if (!L || !this.map || !this.course) return;
    // Zooming out to the whole route is an overview action: stop following.
    if (this.following) this.setFollowing(false);
    const latlngs = this.course.points.map((p) => [p.lat, p.lon] as LeafletNS.LatLngTuple);
    this.map.fitBounds(L.latLngBounds(latlngs).pad(0.1));
  }

  /** Called as often as the ride loop runs; it only records where to aim for. */
  setRider(lat: number, lon: number): void {
    this.target = { lat, lon };
    if (!this.shown) {
      // First fix for this route: go straight there rather than waiting for the
      // rider to drift out of the dead zone.
      this.shown = { lat, lon };
      this.recentre();
    }
    this.startLoop();
  }

  setHover(position: { lat: number; lon: number } | undefined): void {
    const L = this.L;
    if (!L || !this.map) return;
    if (!position) {
      this.hoverMarker?.remove();
      this.hoverMarker = undefined;
      return;
    }
    const latlng: LeafletNS.LatLngTuple = [position.lat, position.lon];
    if (this.hoverMarker) this.hoverMarker.setLatLng(latlng);
    else {
      this.hoverMarker = L.circleMarker(latlng, {
        radius: 5, color: '#0b0e13', weight: 2, fillColor: '#fff', fillOpacity: 1,
      }).addTo(this.map);
    }
  }

  // ---- animation -----------------------------------------------------------

  private startLoop(): void {
    if (this.raf !== undefined || !this.map || !this.visible) return;
    this.lastFrame = undefined;
    this.raf = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
  }

  private frame = (): void => {
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.5, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    const map = this.map;
    if (!map || !this.target || !this.shown) return;

    const jump = haversine(this.shown, this.target);
    if (jump > SNAP_METRES) {
      this.shown = { ...this.target };
      if (this.following) {
        map.setView([this.shown.lat, this.shown.lon], map.getZoom(), { animate: false });
        this.lastPanAt = now;
      }
    } else if (dt > 0 && jump > 0) {
      const alpha = 1 - Math.exp(-dt / SMOOTH_TAU);
      this.shown = {
        lat: this.shown.lat + (this.target.lat - this.shown.lat) * alpha,
        lon: this.shown.lon + (this.target.lon - this.shown.lon) * alpha,
      };
    }

    this.drawRider(map, this.shown);
    if (this.following) this.maybePan(map, this.shown, now);
  };

  private drawRider(map: LeafletNS.Map, at: { lat: number; lon: number }): void {
    const L = this.L;
    if (!L) return;
    const latlng: LeafletNS.LatLngTuple = [at.lat, at.lon];
    if (this.rider) this.rider.setLatLng(latlng);
    else {
      this.rider = L.circleMarker(latlng, {
        radius: 6, color: '#fff', weight: 2.5, fillColor: '#f0c33c', fillOpacity: 1,
      }).addTo(map);
    }
  }

  /** Pan only once the rider has drifted out of a dead zone in the middle, and
   *  then animate it: a CSS-transform pan is smooth where a per-frame setView
   *  snaps the whole view and reloads tiles. */
  private maybePan(map: LeafletNS.Map, at: { lat: number; lon: number }, now: number): void {
    if (now - this.lastPanAt < PAN_SECONDS * 1000) return;
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return;
    const point = map.latLngToContainerPoint([at.lat, at.lon]);
    const drift = Math.hypot(point.x - size.x / 2, point.y - size.y / 2);
    const deadZone = Math.max(DEAD_ZONE_MIN_PX, Math.min(size.x, size.y) * DEAD_ZONE_FRACTION);
    if (drift <= deadZone) return;
    this.lastPanAt = now;
    map.panTo([at.lat, at.lon], {
      animate: true,
      duration: PAN_SECONDS,
      easeLinearity: 0.4,
      noMoveStart: true,
    });
  }

  /** Where the map is looking, and where the rider is drawn. Read-only, and the
   *  only way to check the follow behaviour without a pair of eyes on screen. */
  get viewState(): {
    lat: number; lon: number; zoom: number; following: boolean;
    rider?: { lat: number; lon: number };
  } | undefined {
    if (!this.map) return undefined;
    const centre = this.map.getCenter();
    return {
      lat: centre.lat,
      lon: centre.lng,
      zoom: this.map.getZoom(),
      following: this.following,
      rider: this.shown ? { ...this.shown } : undefined,
    };
  }
}
