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
