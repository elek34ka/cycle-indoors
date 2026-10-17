import { settings } from '../../core/settings';
import { BleDevice } from './ble-device';
import { BODY_SENSOR_LOCATION, CHARACTERISTIC, SERVICE } from './uuids';
import { parseCsc, parseCyclingPower, parseHeartRate } from './parsers';
import { CrankCadenceTracker, WheelSpeedTracker } from './revolutions';

export class BleHeartRateMonitor extends BleDevice {
  location: string | undefined;
  contactDetected: boolean | undefined;

  constructor(bt: BluetoothDevice) {
    super(bt, bt.name ?? 'Heart rate monitor', ['heartRate']);
  }

  protected override async subscribe(server: BluetoothRemoteGATTServer): Promise<void> {
    const location = await this.readOnce(server, SERVICE.heartRate, CHARACTERISTIC.bodySensorLocation);
    if (location) this.location = BODY_SENSOR_LOCATION[location.getUint8(0)];

    const subscribed = await this.notifyOn(
      server, SERVICE.heartRate, CHARACTERISTIC.heartRateMeasurement,
      (view) => {
        const data = parseHeartRate(view);
        this.contactDetected = data.contactDetected;
        // A strap reporting "no skin contact" sends a stale number; drop it.
        if (data.contactDetected === false) return;
        this.emitTelemetry({ heartRate: data.heartRate });
      },
    );
    if (!subscribed) throw new Error('This device has no Heart Rate Measurement characteristic');
  }
}

/** Cycling Power Service: power, plus cadence from the crank and speed from the
 *  wheel when the meter reports them. */
export class BlePowerMeter extends BleDevice {
  private cadence = new CrankCadenceTracker();
  private wheel = new WheelSpeedTracker(2048);
  reportsCadence = false;
  reportsWheel = false;

  constructor(bt: BluetoothDevice) {
    super(bt, bt.name ?? 'Power meter', ['power', 'cadence', 'speed']);
  }

  protected override async subscribe(server: BluetoothRemoteGATTServer): Promise<void> {
    this.cadence.reset();
    this.wheel.reset();
    const subscribed = await this.notifyOn(
      server, SERVICE.cyclingPower, CHARACTERISTIC.cyclingPowerMeasurement,
      (view) => {
        const data = parseCyclingPower(view);
        const now = performance.now();
        const telemetry: { power: number; cadence?: number; speed?: number; distance?: number } = { power: data.power };
        if (data.crank) {
          this.reportsCadence = true;
          const rpm = this.cadence.update(data.crank, now);
          if (rpm !== undefined) telemetry.cadence = rpm;
        }
        if (data.wheel) {
          this.reportsWheel = true;
          const update = this.wheel.update(data.wheel, settings.current.wheelCircumference, now);
          if (update.speed !== undefined) telemetry.speed = update.speed;
          telemetry.distance = update.totalDistance;
        }
        this.emitTelemetry(telemetry);
      },
    );
    if (!subscribed) throw new Error('This device has no Cycling Power Measurement characteristic');
  }
}

/** Cycling Speed and Cadence Service. Both event times tick at 1/1024 s here. */
export class BleSpeedCadenceSensor extends BleDevice {
  private cadence = new CrankCadenceTracker();
  private wheel = new WheelSpeedTracker(1024);
  reportsCadence = false;
  reportsWheel = false;

  constructor(bt: BluetoothDevice) {
    super(bt, bt.name ?? 'Speed / cadence sensor', ['cadence', 'speed']);
  }

  protected override async subscribe(server: BluetoothRemoteGATTServer): Promise<void> {
    this.cadence.reset();
    this.wheel.reset();
    const subscribed = await this.notifyOn(
      server, SERVICE.cyclingSpeedCadence, CHARACTERISTIC.cscMeasurement,
      (view) => {
        const data = parseCsc(view);
        const now = performance.now();
        const telemetry: { cadence?: number; speed?: number; distance?: number } = {};
        if (data.crank) {
          this.reportsCadence = true;
          const rpm = this.cadence.update(data.crank, now);
          if (rpm !== undefined) telemetry.cadence = rpm;
        }
        if (data.wheel) {
          this.reportsWheel = true;
          const update = this.wheel.update(data.wheel, settings.current.wheelCircumference, now);
          if (update.speed !== undefined) telemetry.speed = update.speed;
          telemetry.distance = update.totalDistance;
        }
        this.emitTelemetry(telemetry);
      },
    );
    if (!subscribed) throw new Error('This device has no CSC Measurement characteristic');
  }
}
