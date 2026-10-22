import { Emitter } from '../../core/pubsub';
import type { SimulationParams, SpinDownSignal, TrainerControl, TrainerSpinDown } from '../types';
import { BleDevice } from './ble-device';
import {
  CONTROL_OPCODE, FtmsControlPoint, encodeSimulation, encodeSpinDown, encodeStopOrPause,
  encodeTargetPower, parseSpinDownTargets,
} from './ftms-control';
import {
  parseFitnessMachineFeature, parseIndoorBikeData, parseSupportedPowerRange,
  type FitnessMachineFeatures, type PowerRange,
} from './parsers';
import { CHARACTERISTIC, SERVICE } from './uuids';

/** Fitness Machine Status (0x2ADA) opcodes. 0xFF is the one that matters: the
 *  trainer has taken control back, and it must be requested again. */
const MACHINE_STATUS: Record<number, string> = {
  0x01: 'reset',
  0x02: 'stopped or paused by the rider',
  0x03: 'stopped by the safety key',
  0x04: 'started or resumed by the rider',
  0x05: 'target speed changed',
  0x06: 'target incline changed',
  0x07: 'target resistance changed',
  0x08: 'target power changed',
  0x09: 'target heart rate changed',
  0x12: 'simulation parameters changed',
  0x13: 'wheel circumference changed',
  0x14: 'spin-down status',
  0x15: 'target cadence changed',
  0xff: 'control permission lost',
};

const CONTROL_LOST = 0xff;
const SPIN_DOWN_STATUS = 0x14;

/** The parameter of a spin-down status (0x14). */
const SPIN_DOWN_SIGNAL: Record<number, SpinDownSignal> = {
  0x01: 'speedUp',
  0x02: 'success',
  0x03: 'error',
  0x04: 'stopPedalling',
};

const SPIN_DOWN_TEXT: Record<SpinDownSignal, string> = {
  speedUp: 'spin-down: speed up',
  stopPedalling: 'spin-down: stop pedalling',
  success: 'spin-down succeeded',
  error: 'spin-down failed',
  controlLost: 'control permission lost',
};

async function write(characteristic: BluetoothRemoteGATTCharacteristic, bytes: Uint8Array): Promise<void> {
  // Prefer an acknowledged write: an unacknowledged one can be dropped silently.
  if (typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(bytes as unknown as BufferSource);
  } else {
    await characteristic.writeValue(bytes as unknown as BufferSource);
  }
}

/** A trainer speaking the standard Fitness Machine Service: reads its data and
 *  drives its brake in ERG or simulation mode. */
export class FtmsTrainer extends BleDevice {
  features: FitnessMachineFeatures | undefined;
  powerRange: PowerRange | undefined;
  hasControlPoint = false;
  lastMachineStatus: string | undefined;
  controlError: string | undefined;

  private controlPoint: FtmsControlPoint | undefined;
  private readonly spinDownBus = new Emitter<{ signal: SpinDownSignal }>();

  private readonly spinDownApi: TrainerSpinDown = {
    start: async () => {
      const point = this.requireControl();
      const response = await point.command(encodeSpinDown(true), CONTROL_OPCODE.spinDownControl);
      return response ? parseSpinDownTargets(response.parameters) : undefined;
    },
    cancel: async () => {
      const point = this.requireControl();
      await point.command(encodeSpinDown(false), CONTROL_OPCODE.spinDownControl);
    },
    onSignal: (handler) => this.spinDownBus.on('signal', handler),
  };

  private readonly api: TrainerControl = {
    setTargetPower: async (watts: number) => {
      const point = this.requireControl();
      await point.command(encodeTargetPower(this.clampPower(watts)), CONTROL_OPCODE.setTargetPower);
    },
    setSimulation: async (params: SimulationParams) => {
      const point = this.requireControl();
      await point.command(encodeSimulation(params), CONTROL_OPCODE.setSimulation);
    },
    stop: async () => {
      const point = this.controlPoint;
      if (!point) return;
      await point.command(encodeStopOrPause(false), CONTROL_OPCODE.stopOrPause);
    },
  };

  constructor(bt: BluetoothDevice) {
    super(bt, bt.name ?? 'Smart trainer', ['trainer', 'power', 'cadence', 'speed']);
  }

  /** Only offered once a control point has actually been found on the device,
   *  so the session never tries to command a read-only trainer. */
  get control(): TrainerControl | undefined {
    return this.controlPoint ? this.api : undefined;
  }

  protected override async subscribe(server: BluetoothRemoteGATTServer): Promise<void> {
    this.controlPoint = undefined;
    this.controlError = undefined;

    const feature = await this.readOnce(server, SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineFeature);
    if (feature) this.features = parseFitnessMachineFeature(feature);
    // Only offered to trainers that say they can, so the panel never shows a
    // Calibrate button that can only end in "opcode not supported".
    this.api.spinDown = this.features?.canSet.spinDown ? this.spinDownApi : undefined;

    const range = await this.readOnce(server, SERVICE.fitnessMachine, CHARACTERISTIC.supportedPowerRange);
    if (range && range.byteLength >= 6) this.powerRange = parseSupportedPowerRange(range);

    const subscribed = await this.notifyOn(
      server, SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData,
      (view) => this.onBikeData(view),
    );
    if (!subscribed) {
      throw new Error('This device offers the Fitness Machine Service but no Indoor Bike Data');
    }

    await this.notifyOn(
      server, SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineStatus,
      (view) => this.onMachineStatus(view),
    );

    await this.setUpControl(server);
  }

  private async setUpControl(server: BluetoothRemoteGATTServer): Promise<void> {
    const characteristic = await this.getCharacteristic(
      server, SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint,
    );
    this.hasControlPoint = characteristic !== undefined;
    if (!characteristic) return;

    // Responses come back as indications on the control point itself.
    await this.notifyOn(
      server, SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint,
      (view) => this.controlPoint?.onIndication(view),
    );

    const point = new FtmsControlPoint({ write: (bytes) => write(characteristic, bytes) });
    this.controlPoint = point;

    // Ask for control now rather than on the first target, so a trainer that
    // refuses says so while the rider is still looking at the devices panel.
    // Not awaited: a trainer that never answers its control point would
    // otherwise hold the whole connection in "connecting" for seconds, when
    // its data is already flowing.
    void point.ensureControl().catch((err) => {
      this.controlError = (err as Error).message;
    });
  }

  private requireControl(): FtmsControlPoint {
    if (!this.controlPoint) throw new Error(`${this.label} has no control point`);
    return this.controlPoint;
  }

  /** Keep targets inside what the trainer said it can do. */
  private clampPower(watts: number): number {
    const range = this.powerRange;
    if (!range) return Math.max(0, Math.round(watts));
    return Math.max(range.min, Math.min(range.max, Math.round(watts)));
  }

  private onBikeData(view: DataView): void {
    const data = parseIndoorBikeData(view);
    this.emitTelemetry({
      power: data.power,
      cadence: data.cadence,
      speed: data.speed,
      heartRate: data.heartRate,
      distance: data.totalDistance,
    });
  }

  private onMachineStatus(view: DataView): void {
    const opcode = view.getUint8(0);
    this.lastMachineStatus = MACHINE_STATUS[opcode] ?? `status 0x${opcode.toString(16)}`;
    if (opcode === CONTROL_LOST) {
      // Next command re-requests control instead of failing.
      this.controlPoint?.invalidate();
      this.spinDownBus.emit('signal', 'controlLost');
    }
    if (opcode === SPIN_DOWN_STATUS && view.byteLength >= 2) {
      const signal = SPIN_DOWN_SIGNAL[view.getUint8(1)];
      if (signal) {
        this.lastMachineStatus = SPIN_DOWN_TEXT[signal];
        this.spinDownBus.emit('signal', signal);
      }
    }
  }

  /** A short human description of what this trainer will let the app do. */
  describeControl(): string {
    if (!this.hasControlPoint) return 'no control point — read only';
    const can = this.features?.canSet;
    if (!can) return 'control point present';
    const modes = [
      can.power ? 'ERG' : null,
      can.simulation ? 'simulation' : null,
      can.resistance ? 'resistance' : null,
    ].filter(Boolean);
    return modes.length ? `supports ${modes.join(' + ')}` : 'control point present, no usable targets';
  }

  /** Whether the brake is actually under this app's command right now. */
  describeControlState(): string {
    if (!this.controlPoint) return this.hasControlPoint ? 'control not set up' : 'read only';
    if (this.controlError) return this.controlError;
    if (!this.controlPoint.hasControl) return 'waiting for control';
    if (this.controlPoint.silent) return 'in control (trainer does not acknowledge)';
    return 'in control';
  }

  get lastControlResult(): string | undefined {
    return this.controlPoint?.lastResult;
  }
}
