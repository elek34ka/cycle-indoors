import { Emitter } from '../../core/pubsub';
import type { Device, DeviceRole, DeviceStatus, Telemetry } from '../types';
import { CHARACTERISTIC, SERVICE } from './uuids';
import { parseUtf8 } from './parsers';

/** Backoff schedule for getting a dropped sensor back, in milliseconds.
 *  A trainer that browns out mid-interval should come back on its own. */
const RETRY_DELAYS = [700, 1500, 3000, 6000, 10000, 20000, 30000];

export type BleIdentity = { manufacturer?: string; model?: string; firmware?: string };

/** Shared Web Bluetooth plumbing: GATT connect, notification subscriptions,
 *  battery, device identity, and automatic reconnection after a drop. */
export abstract class BleDevice implements Device {
  readonly transport = 'ble' as const;
  readonly id: string;
  status: DeviceStatus = 'disconnected';
  battery: number | undefined;
  label: string;
  identity: BleIdentity = {};
  /** set when the link dropped on its own and we are trying to get it back */
  lastError: string | undefined;

  private telemetryBus = new Emitter<{ data: Telemetry }>();
  private statusBus = new Emitter<{ status: DeviceStatus }>();
  private wanted = false;
  private retryIndex = 0;
  private retryTimer: number | undefined;
  private notifying: BluetoothRemoteGATTCharacteristic[] = [];
  /**
   * Scopes every notification listener to the current GATT link. Chrome hands
   * back the *same* characteristic object after a reconnect, so without this
   * each reconnect would leave the old listener attached and every packet would
   * be processed twice.
   */
  private link: AbortController | undefined;

  constructor(
    protected readonly bt: BluetoothDevice,
    label: string,
    readonly roles: readonly DeviceRole[],
  ) {
    this.id = `ble:${bt.id}`;
    this.label = label || bt.name || 'Bluetooth device';
    bt.addEventListener('gattserverdisconnected', () => this.onLinkLost());
  }

  /** Subscribe to this device's characteristics. Called on every (re)connect,
   *  so it must re-acquire everything — objects from an old link are dead. */
  protected abstract subscribe(server: BluetoothRemoteGATTServer): Promise<void>;

  async connect(): Promise<void> {
    this.wanted = true;
    this.clearRetry();
    this.retryIndex = 0;
    await this.open();
  }

  async disconnect(): Promise<void> {
    this.wanted = false;
    this.clearRetry();
    await this.stopNotifications();
    this.link?.abort();
    this.link = undefined;
    try {
      if (this.bt.gatt?.connected) this.bt.gatt.disconnect();
    } catch (err) {
      console.warn(`${this.label}: disconnect failed`, err);
    }
    this.setStatus('disconnected');
  }

  onTelemetry(handler: (t: Telemetry) => void): () => void { return this.telemetryBus.on('data', handler); }
  onStatus(handler: (s: DeviceStatus) => void): () => void { return this.statusBus.on('status', handler); }

  protected emitTelemetry(telemetry: Telemetry): void {
    this.telemetryBus.emit('data', telemetry);
  }

  private async open(): Promise<void> {
    if (!this.bt.gatt) throw new Error('This device exposes no GATT server');
    this.setStatus('connecting');
    // Drop any listeners from a previous link before building a new one.
    this.link?.abort();
    this.link = new AbortController();
    this.notifying = [];
    try {
      const server = await this.bt.gatt.connect();
      await this.readIdentity(server);
      await this.subscribe(server);
      await this.watchBattery(server);
      this.retryIndex = 0;
      this.lastError = undefined;
      this.setStatus('connected');
    } catch (err) {
      this.lastError = (err as Error).message;
      // Distinguish "could not reach it" from "reached it, and it is not what
      // we need". The first is worth retrying; the second never will be, so
      // close the link rather than hammering a device that cannot work.
      if (this.bt.gatt?.connected) {
        this.wanted = false;
        this.link?.abort();
        this.link = undefined;
        try { this.bt.gatt.disconnect(); } catch { /* already gone */ }
      }
      this.setStatus('error');
      throw err;
    }
  }

  private onLinkLost(): void {
    this.notifying = [];
    if (!this.wanted) {
      this.setStatus('disconnected');
      return;
    }
    this.lastError = 'connection lost';
    this.setStatus('connecting');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.clearRetry();
    const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
    this.retryIndex++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.wanted) return;
      this.open().catch(() => {
        // Keep trying: the rider may simply have the trainer unplugged.
        if (this.wanted) this.scheduleRetry();
      });
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async stopNotifications(): Promise<void> {
    const characteristics = this.notifying;
    this.notifying = [];
    await Promise.all(characteristics.map(async (c) => {
      try { await c.stopNotifications(); } catch { /* link may already be gone */ }
    }));
  }

  /** Subscribe to a characteristic. Returns false when it is not offered. */
  protected async notifyOn(
    server: BluetoothRemoteGATTServer,
    service: number | string,
    characteristic: number | string,
    handler: (view: DataView) => void,
  ): Promise<boolean> {
    const found = await this.getCharacteristic(server, service, characteristic);
    if (!found) return false;
    found.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      try { handler(value); } catch (err) { console.warn(`${this.label}: bad packet`, err); }
    }, { signal: this.link?.signal });
    await found.startNotifications();
    this.notifying.push(found);
    return true;
  }

  protected async readOnce(
    server: BluetoothRemoteGATTServer,
    service: number | string,
    characteristic: number | string,
  ): Promise<DataView | undefined> {
    const found = await this.getCharacteristic(server, service, characteristic);
    if (!found) return undefined;
    try { return await found.readValue(); } catch { return undefined; }
  }

  protected async getCharacteristic(
    server: BluetoothRemoteGATTServer,
    service: number | string,
    characteristic: number | string,
  ): Promise<BluetoothRemoteGATTCharacteristic | undefined> {
    try {
      const gattService = await server.getPrimaryService(service);
      return await gattService.getCharacteristic(characteristic);
    } catch {
      // Optional services are routinely absent; that is not an error.
      return undefined;
    }
  }

  private async readIdentity(server: BluetoothRemoteGATTServer): Promise<void> {
    const read = async (uuid: number) => {
      const view = await this.readOnce(server, SERVICE.deviceInformation, uuid);
      return view ? parseUtf8(view) : undefined;
    };
    this.identity = {
      manufacturer: await read(CHARACTERISTIC.manufacturerName),
      model: await read(CHARACTERISTIC.modelNumber),
      firmware: await read(CHARACTERISTIC.firmwareRevision),
    };
    if (!this.bt.name && (this.identity.manufacturer || this.identity.model)) {
      this.label = [this.identity.manufacturer, this.identity.model].filter(Boolean).join(' ');
    }
  }

  private async watchBattery(server: BluetoothRemoteGATTServer): Promise<void> {
    const view = await this.readOnce(server, SERVICE.battery, CHARACTERISTIC.batteryLevel);
    if (view) this.battery = view.getUint8(0);
    // Not every sensor notifies on battery; a one-off read is enough if not.
    await this.notifyOn(server, SERVICE.battery, CHARACTERISTIC.batteryLevel, (v) => {
      this.battery = v.getUint8(0);
      this.statusBus.emit('status', this.status);
    });
  }

  protected setStatus(status: DeviceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusBus.emit('status', status);
  }
}
