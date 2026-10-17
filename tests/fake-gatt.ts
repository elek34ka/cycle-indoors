/** A minimal stand-in for the Web Bluetooth GATT API: enough to drive the real
 *  device classes through connect, notify, drop and reconnect. */

const BASE = (value: number) => `0000${value.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export function normalise(uuid: number | string): string {
  return typeof uuid === 'number' ? BASE(uuid) : String(uuid).toLowerCase();
}

export class FakeCharacteristic {
  value: DataView | undefined;
  notifying = false;
  startCalls = 0;
  stopCalls = 0;
  /** every payload written to this characteristic, in order */
  writes: Uint8Array[] = [];
  /** set to reply to a write, as a trainer's control point would */
  onWrite: ((bytes: Uint8Array) => DataView | undefined) | undefined;
  failWrites = false;
  private listeners: ((event: { target: FakeCharacteristic }) => void)[] = [];

  constructor(readonly uuid: string, initial?: DataView) { this.value = initial; }

  addEventListener(
    _type: string,
    handler: (event: { target: FakeCharacteristic }) => void,
    options?: { signal?: AbortSignal },
  ): void {
    this.listeners.push(handler);
    // Mirror the real API's signal support: that is what stops listeners from
    // piling up across reconnects.
    options?.signal?.addEventListener('abort', () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    });
  }

  get listenerCount(): number { return this.listeners.length; }

  async startNotifications(): Promise<FakeCharacteristic> {
    this.startCalls++;
    this.notifying = true;
    return this;
  }

  async stopNotifications(): Promise<FakeCharacteristic> {
    this.stopCalls++;
    this.notifying = false;
    return this;
  }

  async writeValueWithResponse(data: BufferSource): Promise<void> {
    if (this.failWrites) throw new Error('GATT write failed');
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength);
    this.writes.push(new Uint8Array(bytes));
    const reply = this.onWrite?.(new Uint8Array(bytes));
    // A real trainer indicates its answer after the write completes.
    if (reply) queueMicrotask(() => this.notify(reply));
  }

  async writeValue(data: BufferSource): Promise<void> {
    await this.writeValueWithResponse(data);
  }

  get lastWrite(): Uint8Array | undefined { return this.writes[this.writes.length - 1]; }

  async readValue(): Promise<DataView> {
    if (!this.value) throw new Error('not readable');
    return this.value;
  }

  /** Push a notification, as the sensor would. */
  notify(view: DataView): void {
    this.value = view;
    for (const handler of this.listeners) handler({ target: this });
  }
}

export class FakeService {
  readonly characteristics = new Map<string, FakeCharacteristic>();
  constructor(readonly uuid: string) {}

  add(uuid: number | string, initial?: DataView): FakeCharacteristic {
    const characteristic = new FakeCharacteristic(normalise(uuid), initial);
    this.characteristics.set(characteristic.uuid, characteristic);
    return characteristic;
  }

  async getCharacteristic(uuid: number | string): Promise<FakeCharacteristic> {
    const found = this.characteristics.get(normalise(uuid));
    if (!found) throw new Error(`No characteristic ${normalise(uuid)}`);
    return found;
  }
}

export class FakeServer {
  connected = false;
  connectCalls = 0;
  failNextConnect = false;

  constructor(private device: FakeBluetoothDevice, readonly services: Map<string, FakeService>) {}

  async connect(): Promise<FakeServer> {
    this.connectCalls++;
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error('GATT connect failed');
    }
    this.connected = true;
    return this;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.device.emitDisconnected();
  }

  async getPrimaryService(uuid: number | string): Promise<FakeService> {
    const found = this.services.get(normalise(uuid));
    if (!found) throw new Error(`No service ${normalise(uuid)}`);
    return found;
  }

  async getPrimaryServices(): Promise<FakeService[]> {
    return [...this.services.values()];
  }
}

export class FakeBluetoothDevice {
  readonly services = new Map<string, FakeService>();
  readonly gatt: FakeServer;
  private listeners: (() => void)[] = [];

  constructor(readonly id: string, public name?: string) {
    this.gatt = new FakeServer(this, this.services);
  }

  service(uuid: number | string): FakeService {
    const key = normalise(uuid);
    let found = this.services.get(key);
    if (!found) { found = new FakeService(key); this.services.set(key, found); }
    return found;
  }

  addEventListener(_type: string, handler: () => void): void { this.listeners.push(handler); }

  emitDisconnected(): void { for (const handler of this.listeners) handler(); }

  /** The link dropping on its own, as opposed to the app disconnecting. */
  drop(): void {
    this.gatt.connected = false;
    this.emitDisconnected();
  }

  /** Characteristic lookup for assertions. */
  characteristic(service: number | string, characteristic: number | string): FakeCharacteristic | undefined {
    return this.services.get(normalise(service))?.characteristics.get(normalise(characteristic));
  }
}

export const bytes = (...values: number[]) => new DataView(Uint8Array.from(values).buffer);
export const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
export const u32le = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
export const text = (value: string) => new DataView(new TextEncoder().encode(value).buffer as ArrayBuffer);
