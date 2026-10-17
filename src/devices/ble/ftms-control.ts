import type { SimulationParams } from '../types';

/** Fitness Machine Control Point (0x2AD9) opcodes, FTMS v1.0 section 4.16. */
export const CONTROL_OPCODE = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetPower: 0x05,
  startOrResume: 0x07,
  stopOrPause: 0x08,
  setSimulation: 0x11,
  responseCode: 0x80,
} as const;

export const RESULT = {
  success: 0x01,
  notSupported: 0x02,
  invalidParameter: 0x03,
  failed: 0x04,
  notPermitted: 0x05,
} as const;

const RESULT_TEXT: Record<number, string> = {
  [RESULT.success]: 'success',
  [RESULT.notSupported]: 'opcode not supported',
  [RESULT.invalidParameter]: 'invalid parameter',
  [RESULT.failed]: 'operation failed',
  [RESULT.notPermitted]: 'control not permitted',
};

const OPCODE_TEXT: Record<number, string> = {
  [CONTROL_OPCODE.requestControl]: 'request control',
  [CONTROL_OPCODE.reset]: 'reset',
  [CONTROL_OPCODE.setTargetPower]: 'set target power',
  [CONTROL_OPCODE.startOrResume]: 'start',
  [CONTROL_OPCODE.stopOrPause]: 'stop',
  [CONTROL_OPCODE.setSimulation]: 'set simulation',
};

export function opcodeName(opcode: number): string {
  return OPCODE_TEXT[opcode] ?? `opcode 0x${opcode.toString(16)}`;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function encodeRequestControl(): Uint8Array {
  return Uint8Array.of(CONTROL_OPCODE.requestControl);
}

export function encodeStartOrResume(): Uint8Array {
  return Uint8Array.of(CONTROL_OPCODE.startOrResume);
}

/** 0x01 stops, 0x02 pauses. Stopping releases the brake at the end of a ride. */
export function encodeStopOrPause(pause = false): Uint8Array {
  return Uint8Array.of(CONTROL_OPCODE.stopOrPause, pause ? 0x02 : 0x01);
}

/** ERG mode: hold this many watts. sint16, 1 W per bit. */
export function encodeTargetPower(watts: number): Uint8Array {
  const out = new Uint8Array(3);
  const view = new DataView(out.buffer);
  view.setUint8(0, CONTROL_OPCODE.setTargetPower);
  view.setInt16(1, clamp(Math.round(watts), -32768, 32767), true);
  return out;
}

/**
 * Free mode: emulate a road. Wind speed is sint16 at 0.001 m/s, grade is sint16
 * at 0.01 %, rolling resistance is uint8 at 0.0001, and the wind resistance
 * coefficient is uint8 at 0.01 kg/m.
 */
export function encodeSimulation(params: SimulationParams): Uint8Array {
  const out = new Uint8Array(7);
  const view = new DataView(out.buffer);
  view.setUint8(0, CONTROL_OPCODE.setSimulation);
  // SimulationParams carries a head wind in km/h; FTMS wants m/s.
  view.setInt16(1, clamp(Math.round((params.windSpeed / 3.6) * 1000), -32768, 32767), true);
  view.setInt16(3, clamp(Math.round(params.grade * 100), -32768, 32767), true);
  view.setUint8(5, clamp(Math.round(params.crr / 0.0001), 0, 255));
  view.setUint8(6, clamp(Math.round(params.cw / 0.01), 0, 255));
  return out;
}

export interface ControlResponse {
  requestOpcode: number;
  result: number;
  ok: boolean;
  text: string;
}

/** Responses arrive as an indication: 0x80, request opcode, result code. */
export function parseControlResponse(view: DataView): ControlResponse | undefined {
  if (view.byteLength < 3) return undefined;
  if (view.getUint8(0) !== CONTROL_OPCODE.responseCode) return undefined;
  const requestOpcode = view.getUint8(1);
  const result = view.getUint8(2);
  return {
    requestOpcode,
    result,
    ok: result === RESULT.success,
    text: RESULT_TEXT[result] ?? `result 0x${result.toString(16)}`,
  };
}

export interface ControlPointIO {
  write(bytes: Uint8Array): Promise<void>;
}

/** How long to wait for a trainer to answer before assuming it never will. */
const RESPONSE_TIMEOUT_MS = 2000;

/**
 * Drives one trainer's control point.
 *
 * Two things make this more than a wrapper around `write`. GATT allows a single
 * outstanding operation per device, so every write is serialised through one
 * chain. And FTMS requires control to be requested before any target is
 * accepted, and can revoke it at any time — so permission is tracked and
 * re-requested rather than assumed.
 */
export class FtmsControlPoint {
  /** last thing the trainer said, for the devices panel */
  lastResult: string | undefined;
  /** set when the trainer accepts commands but never answers them */
  silent = false;

  private chain: Promise<unknown> = Promise.resolve();
  private pending: { opcode: number; settle: (r: ControlResponse | undefined) => void; timer: number } | undefined;
  private granted = false;
  private started = false;

  constructor(private readonly io: ControlPointIO, private readonly timeoutMs = RESPONSE_TIMEOUT_MS) {}

  get hasControl(): boolean { return this.granted; }

  /** Called for every indication on the control point. */
  onIndication(view: DataView): void {
    const response = parseControlResponse(view);
    if (!response) return;
    this.lastResult = `${opcodeName(response.requestOpcode)}: ${response.text}`;
    if (response.result === RESULT.notPermitted) this.granted = false;

    const pending = this.pending;
    if (pending && pending.opcode === response.requestOpcode) {
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.settle(response);
    }
  }

  /** The trainer told us control was taken away (machine status 0xFF). */
  invalidate(): void {
    this.granted = false;
    this.started = false;
  }

  /** Request control if it is not held. Queued, so concurrent callers do not
   *  each fire off their own request. */
  async ensureControl(): Promise<void> {
    return this.enqueue(() => this.grantControl());
  }

  /**
   * Request control if needed, then send a command and check the answer.
   *
   * The whole thing is one slot in the queue. Splitting it would let another
   * command interleave between the control request and the target, which both
   * duplicates the request and — worse — can deliver targets out of order,
   * leaving the trainer holding a wattage the workout has already moved past.
   */
  async command(bytes: Uint8Array, opcode: number): Promise<void> {
    return this.enqueue(async () => {
      await this.grantControl();
      const response = await this.transfer(bytes, opcode);
      if (!response || response.ok) return;
      if (response.result === RESULT.notPermitted) this.granted = false;
      throw new Error(`${opcodeName(opcode)} failed: ${response.text}`);
    });
  }

  /** Must only be called from inside the queue. */
  private async grantControl(): Promise<void> {
    if (this.granted) return;
    const response = await this.transfer(encodeRequestControl(), CONTROL_OPCODE.requestControl);

    if (!response) {
      // Plenty of trainers accept commands without ever indicating a response.
      // Refusing to ride with them would be worse than carrying on.
      this.silent = true;
      this.granted = true;
    } else if (response.ok) {
      this.granted = true;
    } else {
      throw new Error(`trainer refused control (${response.text})`);
    }

    if (!this.started) {
      this.started = true;
      // Some trainers need an explicit start before they apply a target;
      // others answer "not supported". Either is fine.
      await this.transfer(encodeStartOrResume(), CONTROL_OPCODE.startOrResume).catch(() => undefined);
    }
  }

  /** One at a time, in the order asked for, whatever any of them does. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * One write followed by a bounded wait for its indication. GATT permits a
   * single outstanding operation per device, so this must only ever be called
   * from inside the queue.
   */
  private async transfer(bytes: Uint8Array, opcode: number): Promise<ControlResponse | undefined> {
    const waiter = this.expect(opcode);
    try {
      await this.io.write(bytes);
    } catch (err) {
      this.abandon(opcode);
      throw err;
    }
    return waiter;
  }

  private expect(opcode: number): Promise<ControlResponse | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.opcode !== opcode) return;
        this.pending = undefined;
        this.silent = true;
        resolve(undefined);
      }, this.timeoutMs) as unknown as number;
      this.pending = { opcode, settle: resolve, timer };
    });
  }

  private abandon(opcode: number): void {
    if (this.pending?.opcode !== opcode) return;
    clearTimeout(this.pending.timer);
    this.pending.settle(undefined);
    this.pending = undefined;
  }
}
