import type { Device } from '../types';
import { BleHeartRateMonitor, BlePowerMeter, BleSpeedCadenceSensor } from './sensors';
import { FtmsTrainer } from './ftms';
import { SERVICE } from './uuids';

export type PairKind = 'trainer' | 'heartRate' | 'power' | 'speedCadence' | 'any';

const SUPPORT_SERVICES = [
  SERVICE.fitnessMachine, SERVICE.cyclingPower, SERVICE.cyclingSpeedCadence,
  SERVICE.heartRate, SERVICE.battery, SERVICE.deviceInformation,
];

const REQUESTS: Record<Exclude<PairKind, 'any'>, { service: number; label: string }> = {
  trainer: { service: SERVICE.fitnessMachine, label: 'smart trainer' },
  heartRate: { service: SERVICE.heartRate, label: 'heart rate monitor' },
  power: { service: SERVICE.cyclingPower, label: 'power meter' },
  speedCadence: { service: SERVICE.cyclingSpeedCadence, label: 'speed / cadence sensor' },
};

/** 16-bit assigned numbers expand into this base UUID. */
export function uuid16(value: number): string {
  return `0000${value.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

interface BluetoothApi {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  getAvailability?(): Promise<boolean>;
  getDevices?(): Promise<BluetoothDevice[]>;
}

function api(): BluetoothApi | undefined {
  return (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
}

export function isBluetoothSupported(): boolean {
  return api() !== undefined;
}

/** Whether a radio is actually present and on, when the browser will say. */
export async function isBluetoothAvailable(): Promise<boolean> {
  const bluetooth = api();
  if (!bluetooth) return false;
  if (!bluetooth.getAvailability) return true;
  try { return await bluetooth.getAvailability(); } catch { return true; }
}

export function requiresSecureContext(): boolean {
  return !window.isSecureContext;
}

function build(kind: Exclude<PairKind, 'any'>, bt: BluetoothDevice): Device {
  switch (kind) {
    case 'trainer': return new FtmsTrainer(bt);
    case 'heartRate': return new BleHeartRateMonitor(bt);
    case 'power': return new BlePowerMeter(bt);
    case 'speedCadence': return new BleSpeedCadenceSensor(bt);
  }
}

/** Ask the browser's device chooser for a sensor. Must be called from a click:
 *  Web Bluetooth refuses to open the chooser without a user gesture. */
export async function pairDevice(kind: PairKind): Promise<{ device: Device; kind: Exclude<PairKind, 'any'> }> {
  const bluetooth = api();
  if (!bluetooth) throw new Error('This browser has no Web Bluetooth. Use Chrome, Edge or another Chromium browser.');
  if (requiresSecureContext()) {
    throw new Error('Bluetooth needs a secure context — serve the app over https, or use localhost.');
  }

  if (kind === 'any') {
    const bt = await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SUPPORT_SERVICES });
    const detected = await detectKind(bt);
    if (!detected) {
      throw new Error(`"${bt.name ?? 'That device'}" offers none of the services this app can read.`);
    }
    remember(bt, detected);
    return { device: build(detected, bt), kind: detected };
  }

  const request = REQUESTS[kind];
  const bt = await bluetooth.requestDevice({
    filters: [{ services: [request.service] }],
    optionalServices: SUPPORT_SERVICES,
  });
  remember(bt, kind);
  return { device: build(kind, bt), kind };
}

/** Connect and look at what the device actually offers, most useful first. */
async function detectKind(bt: BluetoothDevice): Promise<Exclude<PairKind, 'any'> | undefined> {
  if (!bt.gatt) return undefined;
  const server = await bt.gatt.connect();
  let uuids: string[] = [];
  try {
    const services = await server.getPrimaryServices();
    uuids = services.map((s) => String(s.uuid).toLowerCase());
  } catch {
    uuids = [];
  }
  const has = (service: number) => uuids.includes(uuid16(service));
  if (has(SERVICE.fitnessMachine)) return 'trainer';
  if (has(SERVICE.cyclingPower)) return 'power';
  if (has(SERVICE.cyclingSpeedCadence)) return 'speedCadence';
  if (has(SERVICE.heartRate)) return 'heartRate';
  return undefined;
}

// ---- remembering paired devices ------------------------------------------

const KNOWN_KEY = 'cycle-indoors.ble-known.v1';

interface KnownDevice { id: string; name: string; kind: Exclude<PairKind, 'any'>; }

function readKnown(): KnownDevice[] {
  try {
    const raw = localStorage.getItem(KNOWN_KEY);
    return raw ? (JSON.parse(raw) as KnownDevice[]) : [];
  } catch { return []; }
}

function writeKnown(list: KnownDevice[]): void {
  try { localStorage.setItem(KNOWN_KEY, JSON.stringify(list)); } catch { /* non-fatal */ }
}

function remember(bt: BluetoothDevice, kind: Exclude<PairKind, 'any'>): void {
  const list = readKnown().filter((d) => d.id !== bt.id);
  list.push({ id: bt.id, name: bt.name ?? 'Bluetooth device', kind });
  writeKnown(list);
}

export function forgetDevice(id: string): void {
  writeKnown(readKnown().filter((d) => `ble:${d.id}` !== id && d.id !== id));
}

export function knownDeviceNames(): KnownDevice[] {
  return readKnown();
}

/**
 * Devices the browser still holds permission for, rebuilt as app devices so
 * they appear in the panel with a Connect button. Chrome only exposes this
 * once the user has paired something, and it is not in every browser.
 */
export async function restorePairedDevices(): Promise<Device[]> {
  const bluetooth = api();
  if (!bluetooth?.getDevices) return [];
  let granted: BluetoothDevice[] = [];
  try { granted = await bluetooth.getDevices(); } catch { return []; }
  const known = readKnown();
  const devices: Device[] = [];
  for (const bt of granted) {
    const match = known.find((d) => d.id === bt.id);
    if (match) devices.push(build(match.kind, bt));
  }
  return devices;
}
