import { Emitter } from './pubsub';
import { PRESETS, matchPreset, type SmoothingParams, type SmoothingPreset } from '../activity/smoothing';
import { NO_FILTERS, type LibraryFilters, type LibrarySection } from '../library/filter';

export interface Settings {
  ftp: number;            // W
  hrMax: number;          // bpm
  riderWeight: number;    // kg
  bikeWeight: number;     // kg
  wheelCircumference: number; // mm, for speed from a wheel-revolution sensor (phase 2)
  useMockDevices: boolean;
  smoothPowerSeconds: number; // display smoothing for power and HR (0 = raw)
  showMiniMap: boolean;
  /** where the rider dragged the route map, in px from the window's top-left;
   *  null keeps it in its default corner of the workout graph */
  miniMapPosition: { left: number; top: number } | null;
  /** keep the mini map centred on the rider rather than showing the whole route */
  miniMapFollow: boolean;
  /** try to reconnect already-paired Bluetooth devices when the app loads */
  autoConnectBle: boolean;
  /** the ride view's left panel (workout and route) */
  showSidebar: boolean;
  /** shows diagnostic tools, such as the Bluetooth log download */
  debugMode: boolean;
  /** the Route smoother's last parameters, and which preset they came from */
  routeSmoothing: SmoothingParams & { preset: SmoothingPreset };
  /** upload each finished ride to Strava without pressing the button */
  stravaAutoUpload: boolean;
  /** the Library's open section and its search and filters */
  librarySection: LibrarySection;
  libraryFilters: LibraryFilters;
}

const DEFAULTS: Settings = {
  ftp: 220,
  hrMax: 185,
  riderWeight: 75,
  bikeWeight: 8,
  wheelCircumference: 2096,
  useMockDevices: false,
  smoothPowerSeconds: 3,
  showMiniMap: true,
  miniMapPosition: null,
  miniMapFollow: true,
  autoConnectBle: true,
  showSidebar: true,
  debugMode: false,
  routeSmoothing: { ...PRESETS.medium, preset: 'medium' },
  stravaAutoUpload: false,
  librarySection: 'workouts',
  libraryFilters: NO_FILTERS,
};

const KEY = 'cycle-indoors.settings.v1';

/** Saved settings over the defaults. The smoother's preset name is worked out
 *  again from its values, because the presets' values have moved since some
 *  settings were saved; the values themselves are kept as they were. */
export function restoreSettings(saved: Partial<Settings>): Settings {
  const value = { ...DEFAULTS, ...saved };
  return {
    ...value,
    routeSmoothing: { ...value.routeSmoothing, preset: matchPreset(value.routeSmoothing) },
    // filters added later still get their defaults
    libraryFilters: { ...NO_FILTERS, ...saved.libraryFilters },
  };
}

class SettingsStore extends Emitter<{ change: Settings }> {
  private value: Settings;

  constructor() {
    super();
    this.value = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.value = restoreSettings(JSON.parse(raw));
    } catch { /* first run, private mode, or cleared storage */ }
  }

  get current(): Readonly<Settings> { return this.value; }

  patch(partial: Partial<Settings>): void {
    this.value = { ...this.value, ...partial };
    try { localStorage.setItem(KEY, JSON.stringify(this.value)); } catch { /* non-fatal */ }
    this.emit('change', this.value);
  }

  reset(): void { this.patch({ ...DEFAULTS }); }
}

export const settings = new SettingsStore();
