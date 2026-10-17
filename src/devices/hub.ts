import { Emitter } from '../core/pubsub';
import type { Device, DeviceRole, Telemetry, TrainerControl } from './types';

/** How long a value stays fresh before the dashboard shows "--". */
const STALE_MS = 5000;

interface Reading {
  value: number;
  at: number;
  from: string;
  /** readings from the trainer lose to a dedicated sensor for the same metric */
  fromTrainer: boolean;
}

type HubEvents = {
  devices: Device[];
  telemetry: Telemetry;
};

/** Holds every connected device and merges their streams into one telemetry
 *  object, preferring a dedicated sensor over the trainer's own estimate. */
export class DeviceHub extends Emitter<HubEvents> {
  private devices: Device[] = [];
  private readings = new Map<string, Reading[]>();
  private cleanups = new Map<string, (() => void)[]>();

  list(): readonly Device[] { return this.devices; }

  find(id: string): Device | undefined { return this.devices.find((d) => d.id === id); }

  register(device: Device): Device {
    if (this.find(device.id)) return device;
    this.devices.push(device);
    this.cleanups.set(device.id, [
      device.onTelemetry((t) => this.ingest(device, t)),
      device.onStatus(() => {
        if (device.status !== 'connected') this.dropReadings(device.id);
        this.emit('devices', [...this.devices]);
      }),
    ]);
    this.emit('devices', [...this.devices]);
    return device;
  }

  async unregister(id: string): Promise<void> {
    const device = this.find(id);
    if (!device) return;
    if (device.status === 'connected') await device.disconnect().catch(() => {});
    this.cleanups.get(id)?.forEach((fn) => fn());
    this.cleanups.delete(id);
    this.dropReadings(id);
    this.devices = this.devices.filter((d) => d.id !== id);
    this.emit('devices', [...this.devices]);
  }

  get trainer(): Device | undefined {
    return this.devices.find((d) => d.roles.includes('trainer') && d.status === 'connected' && d.control)
      ?? this.devices.find((d) => d.roles.includes('trainer') && d.control);
  }

  get control(): TrainerControl | undefined {
    const t = this.trainer;
    return t && t.status === 'connected' ? t.control : undefined;
  }

  connected(role: DeviceRole): Device[] {
    return this.devices.filter((d) => d.status === 'connected' && d.roles.includes(role));
  }

  /** Merged, de-staled snapshot. */
  snapshot(now = performance.now()): Telemetry {
    const pick = (key: string): number | undefined => {
      const list = (this.readings.get(key) ?? []).filter((r) => now - r.at < STALE_MS);
      if (!list.length) return undefined;
      // A dedicated sensor wins over the trainer's own estimate: a strap beats
      // the trainer's HR passthrough, a power meter beats its power estimate.
      const preferred = list.find((r) => !r.fromTrainer) ?? list[0];
      return preferred.value;
    };
    const out: Telemetry = {
      power: pick('power'),
      cadence: pick('cadence'),
      speed: pick('speed'),
      heartRate: pick('heartRate'),
      distance: pick('distance'),
    };
    return out;
  }

  private ingest(device: Device, t: Telemetry): void {
    const now = performance.now();
    const fromTrainer = device.roles.includes('trainer');
    for (const key of ['power', 'cadence', 'speed', 'heartRate', 'distance'] as const) {
      const value = t[key];
      if (value === undefined || !Number.isFinite(value)) continue;
      const list = this.readings.get(key) ?? [];
      const existing = list.find((r) => r.from === device.id);
      if (existing) { existing.value = value; existing.at = now; }
      else list.push({ value, at: now, from: device.id, fromTrainer });
      this.readings.set(key, list);
    }
    this.emit('telemetry', this.snapshot(now));
  }

  /** Which device is currently supplying a metric — shown in the devices panel. */
  sourceOf(metric: 'power' | 'cadence' | 'speed' | 'heartRate', now = performance.now()): Device | undefined {
    const list = (this.readings.get(metric) ?? []).filter((r) => now - r.at < STALE_MS);
    if (!list.length) return undefined;
    const preferred = list.find((r) => !r.fromTrainer) ?? list[0];
    return this.find(preferred.from);
  }

  private dropReadings(deviceId: string): void {
    for (const [key, list] of this.readings) {
      this.readings.set(key, list.filter((r) => r.from !== deviceId));
    }
  }
}

export const hub = new DeviceHub();
