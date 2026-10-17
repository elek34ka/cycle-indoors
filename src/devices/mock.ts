import { Emitter } from '../core/pubsub';
import { clamp } from '../core/format';
import { settings } from '../core/settings';
import { DEFAULT_BIKE, kph, speedForPower } from './physics';
import type { Device, DeviceRole, DeviceStatus, SimulationParams, Telemetry, TrainerControl } from './types';

const TICK_MS = 250;
/** How quickly simulated legs converge on the ERG target. */
const POWER_TAU = 2.2;
const HR_TAU = 24;
const HR_REST = 62;

function noise(amount: number): number {
  return (Math.random() * 2 - 1) * amount;
}

/** A shared simulated rider. The trainer and the strap are separate "devices"
 *  so the UI, the hub and the session cannot tell them apart from real ones. */
export class MockRig {
  mode: 'erg' | 'sim' = 'erg';
  targetPower = 0;
  grade = 0;
  /** rider's own effort in free mode, as a fraction of FTP */
  riderEffort = 0.65;
  pedalling = true;

  private power = 0;
  private cadence = 0;
  private hr = HR_REST;
  private distance = 0;
  private drift = 0;
  private timer: number | undefined;
  private listeners = 0;

  readonly bus = new Emitter<{ tick: { power: number; cadence: number; heartRate: number; speed: number; distance: number } }>();

  start(): void {
    this.listeners++;
    if (this.timer !== undefined) return;
    this.timer = window.setInterval(() => this.step(TICK_MS / 1000), TICK_MS);
  }

  stop(): void {
    this.listeners = Math.max(0, this.listeners - 1);
    if (this.listeners === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  reset(): void {
    this.power = 0; this.cadence = 0; this.hr = HR_REST; this.distance = 0; this.drift = 0;
  }

  private demandedPower(): number {
    const { ftp } = settings.current;
    if (!this.pedalling) return 0;
    if (this.mode === 'erg') return this.targetPower;
    // Free mode: the rider holds their chosen effort, and climbs cost a little more.
    const gradeBias = 1 + clamp(this.grade, -5, 10) * 0.01;
    return ftp * this.riderEffort * gradeBias;
  }

  private step(dt: number): void {
    const { ftp, riderWeight, bikeWeight } = settings.current;
    const demand = this.demandedPower();

    // First-order lag towards the demanded power, plus a slow random walk so
    // the trace looks like legs rather than a step function.
    this.drift += noise(0.6) * dt;
    this.drift = clamp(this.drift * (1 - dt / 12), -0.04, 0.04);
    const alpha = 1 - Math.exp(-dt / POWER_TAU);
    const wanted = demand * (1 + this.drift) + noise(demand > 0 ? demand * 0.02 : 0);
    this.power += (wanted - this.power) * alpha;
    if (demand === 0) this.power *= 1 - Math.exp(-dt / 0.8);
    this.power = Math.max(0, this.power);

    const cadenceTarget = demand <= 0 ? 0 : clamp(72 + (this.power / Math.max(1, ftp)) * 22, 60, 115);
    this.cadence += (cadenceTarget + noise(2) - this.cadence) * (1 - Math.exp(-dt / 1.6));
    this.cadence = Math.max(0, this.cadence);

    const ratio = this.power / Math.max(1, ftp);
    const hrTarget = this.power <= 0
      ? HR_REST + 12
      : clamp(HR_REST + (settings.current.hrMax - HR_REST) * (0.34 + ratio * 0.56), HR_REST, settings.current.hrMax);
    this.hr += (hrTarget - this.hr) * (1 - Math.exp(-dt / HR_TAU));

    const speedMs = speedForPower(this.power, {
      ...DEFAULT_BIKE,
      mass: riderWeight + bikeWeight,
      grade: this.mode === 'sim' ? this.grade : 0,
    });
    this.distance += speedMs * dt;

    this.bus.emit('tick', {
      power: Math.round(this.power),
      cadence: Math.round(this.cadence),
      heartRate: Math.round(this.hr + noise(1)),
      speed: kph(speedMs),
      distance: this.distance,
    });
  }
}

abstract class MockDevice implements Device {
  status: DeviceStatus = 'disconnected';
  readonly transport = 'mock' as const;
  battery = 84;

  private telemetry = new Emitter<{ data: Telemetry }>();
  private statusBus = new Emitter<{ status: DeviceStatus }>();
  private unsubscribe: (() => void) | undefined;

  constructor(readonly id: string, readonly label: string, readonly roles: readonly DeviceRole[], protected rig: MockRig) {}

  protected abstract map(tick: { power: number; cadence: number; heartRate: number; speed: number; distance: number }): Telemetry;

  async connect(): Promise<void> {
    this.setStatus('connecting');
    // A real BLE device takes a moment; keep the same shape so the UI is honest.
    await new Promise((resolve) => setTimeout(resolve, 350 + Math.random() * 350));
    this.rig.start();
    this.unsubscribe = this.rig.bus.on('tick', (tick) => this.telemetry.emit('data', this.map(tick)));
    this.setStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.rig.stop();
    this.setStatus('disconnected');
  }

  onTelemetry(handler: (t: Telemetry) => void): () => void { return this.telemetry.on('data', handler); }
  onStatus(handler: (s: DeviceStatus) => void): () => void { return this.statusBus.on('status', handler); }

  protected setStatus(status: DeviceStatus): void {
    this.status = status;
    this.statusBus.emit('status', status);
  }
}

export class MockTrainer extends MockDevice {
  readonly control: TrainerControl;

  constructor(rig: MockRig) {
    super('mock-trainer', 'Simulated trainer (FTMS)', ['trainer', 'power', 'cadence', 'speed'], rig);
    this.control = {
      setTargetPower: async (watts: number) => { this.rig.mode = 'erg'; this.rig.targetPower = Math.max(0, Math.round(watts)); },
      setSimulation: async (params: SimulationParams) => { this.rig.mode = 'sim'; this.rig.grade = params.grade; },
      setResistance: async () => { this.rig.mode = 'sim'; },
      stop: async () => { this.rig.targetPower = 0; },
    };
  }

  protected override map(tick: { power: number; cadence: number; speed: number; distance: number }): Telemetry {
    return { power: tick.power, cadence: tick.cadence, speed: tick.speed, distance: tick.distance };
  }
}

export class MockHeartRateMonitor extends MockDevice {
  constructor(rig: MockRig) {
    super('mock-hrm', 'Simulated HR strap', ['heartRate'], rig);
    this.battery = 71;
  }

  protected override map(tick: { heartRate: number }): Telemetry {
    return { heartRate: tick.heartRate };
  }
}

export function createMockRig(): { rig: MockRig; trainer: MockTrainer; hrm: MockHeartRateMonitor } {
  const rig = new MockRig();
  return { rig, trainer: new MockTrainer(rig), hrm: new MockHeartRateMonitor(rig) };
}
