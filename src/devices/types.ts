export type DeviceRole = 'trainer' | 'heartRate' | 'power' | 'cadence' | 'speed';
export type DeviceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface Telemetry {
  power?: number;
  cadence?: number;
  /** km/h */
  speed?: number;
  heartRate?: number;
  /** cumulative metres, when the device reports it */
  distance?: number;
}

export interface SimulationParams {
  /** road gradient in percent */
  grade: number;
  /** coefficient of rolling resistance */
  crr: number;
  /** wind resistance coefficient, kg/m */
  cw: number;
  /** head wind in km/h, positive = head wind */
  windSpeed: number;
}

/** The speed window a trainer asks for during a spin-down, in km/h: get above
 *  `highKph`, then coast while it measures the run down past `lowKph`. */
export interface SpinDownTargets {
  lowKph: number;
  highKph: number;
}

/** Everything a controllable trainer must offer. FTMS, Wahoo and Tacx
 *  adapters in phase 2 each implement this over their own control point. */
export interface TrainerControl {
  /** ERG mode: hold this power regardless of cadence */
  setTargetPower(watts: number): Promise<void>;
  /** Free / simulation mode: emulate a road gradient */
  setSimulation(params: SimulationParams): Promise<void>;
  /** Optional brake-level control, 0-100 % */
  setResistance?(percent: number): Promise<void>;
  /** Release the brake (end of ride) */
  stop?(): Promise<void>;
  /** Present only on trainers that say they can run a spin-down */
  spinDown?: TrainerSpinDown;
}

/** What a trainer says while a spin-down runs: `controlLost` means it took
 *  control back, which ends the spin-down as surely as an error. */
export type SpinDownSignal = 'speedUp' | 'stopPedalling' | 'success' | 'error' | 'controlLost';

/** Spin-down calibration. The result arrives later, as a signal. */
export interface TrainerSpinDown {
  /** Ask for a spin-down. Resolves with the target window when the trainer
   *  sends one; rejects if it refuses. */
  start(): Promise<SpinDownTargets | undefined>;
  /** Abandon a spin-down in progress */
  cancel(): Promise<void>;
  onSignal(handler: (signal: SpinDownSignal) => void): () => void;
  /** The spin-down is over, however it ended. The trainer has left the state
   *  it was in, so the next target must put it back under control. */
  end?(): void;
}

export interface Device {
  readonly id: string;
  readonly label: string;
  readonly roles: readonly DeviceRole[];
  readonly transport: 'mock' | 'ble';
  readonly control?: TrainerControl;
  status: DeviceStatus;
  battery?: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onTelemetry(handler: (t: Telemetry) => void): () => void;
  onStatus(handler: (s: DeviceStatus) => void): () => void;
}

export function hasRole(device: Device, role: DeviceRole): boolean {
  return device.roles.includes(role);
}
