/** Bluetooth SIG assigned numbers for the services this app speaks.
 *  Web Bluetooth accepts 16-bit numbers directly and normalises them. */
export const SERVICE = {
  fitnessMachine: 0x1826,
  heartRate: 0x180d,
  cyclingPower: 0x1818,
  cyclingSpeedCadence: 0x1816,
  battery: 0x180f,
  deviceInformation: 0x180a,
  /** Wahoo trainers expose ERG control here rather than on FTMS (phase 3) */
  wahooExtension: 'a026ee01-0a7d-4ab3-97fa-f1500f9feb8b',
} as const;

export const CHARACTERISTIC = {
  // Fitness Machine Service
  indoorBikeData: 0x2ad2,
  fitnessMachineFeature: 0x2acc,
  fitnessMachineControlPoint: 0x2ad9,
  fitnessMachineStatus: 0x2ada,
  supportedPowerRange: 0x2ad8,
  supportedResistanceLevelRange: 0x2ad6,
  // Heart Rate Service
  heartRateMeasurement: 0x2a37,
  bodySensorLocation: 0x2a38,
  // Cycling Power Service
  cyclingPowerMeasurement: 0x2a63,
  cyclingPowerFeature: 0x2a65,
  // Cycling Speed and Cadence Service
  cscMeasurement: 0x2a5b,
  cscFeature: 0x2a5c,
  // Battery Service
  batteryLevel: 0x2a19,
  // Device Information
  manufacturerName: 0x2a29,
  modelNumber: 0x2a24,
  firmwareRevision: 0x2a26,
} as const;

/** Body Sensor Location values (0x2A38). */
export const BODY_SENSOR_LOCATION = [
  'other', 'chest', 'wrist', 'finger', 'hand', 'ear lobe', 'foot',
] as const;
