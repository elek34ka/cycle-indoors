import { settings } from '../../core/settings';
import { CHARACTERISTIC } from './uuids';

export type BleLogKind = 'write' | 'response' | 'notify';

export interface BleLogEntry {
  at: Date;
  device: string;
  kind: BleLogKind;
  /** the characteristic, when known */
  uuid?: number | string;
  /** raw bytes as space-separated hex */
  hex: string;
  /** a short decoded description, when there is one */
  note?: string;
}

/** About ten minutes of 4 Hz bike data from two devices, with plenty of
 *  headroom for control traffic. */
const DEFAULT_LIMIT = 20_000;

const CHARACTERISTIC_NAME = new Map<number | string, string>(
  Object.entries(CHARACTERISTIC).map(([name, uuid]) => [uuid, name]),
);

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

function bytesOf(data: Uint8Array | DataView): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * What the app and its Bluetooth devices actually said to each other, so a
 * misbehaving trainer can be diagnosed from evidence. Bounded, in memory only,
 * and never sent anywhere: the rider downloads it if they want to share it.
 */
export class BleLog {
  private items: BleLogEntry[] = [];
  private on = true;

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  /** Whether anything is being recorded. Callers check it before doing any
   *  work for an entry, such as decoding a packet for its note. */
  get enabled(): boolean { return this.on; }

  /** Switching off also drops what was recorded, to give the memory back. */
  set enabled(value: boolean) {
    this.on = value;
    if (!value) this.clear();
  }

  record(entry: {
    device: string;
    kind: BleLogKind;
    uuid?: number | string;
    bytes: Uint8Array | DataView;
    note?: string;
  }): void {
    if (!this.on) return;
    this.items.push({
      at: new Date(),
      device: entry.device,
      kind: entry.kind,
      uuid: entry.uuid,
      hex: toHex(bytesOf(entry.bytes)),
      note: entry.note,
    });
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  entries(): readonly BleLogEntry[] { return this.items; }

  clear(): void { this.items = []; }

  /** One line per entry, oldest first: time, device, kind, characteristic, bytes, note. */
  toText(): string {
    if (this.items.length === 0) return 'Bluetooth log is empty: no device has talked to the app since the page loaded.\n';
    return this.items.map((e) => {
      const uuid = e.uuid === undefined ? '-'
        : CHARACTERISTIC_NAME.get(e.uuid) ?? (typeof e.uuid === 'number' ? `0x${e.uuid.toString(16)}` : e.uuid);
      return [e.at.toISOString(), e.device, e.kind, uuid, e.hex || '(empty)', e.note ?? ''].join('\t').trimEnd();
    }).join('\n') + '\n';
  }
}

export const bleLog = new BleLog();
// Only recorded in debug mode: bike data alone is several packets a second.
bleLog.enabled = settings.current.debugMode;
settings.on('change', (s) => { if (bleLog.enabled !== s.debugMode) bleLog.enabled = s.debugMode; });
