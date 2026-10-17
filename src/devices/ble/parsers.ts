/** Pure parsers for the BLE characteristics this app reads. Every one of these
 *  is driven only by a DataView, which is what makes them testable without a
 *  trainer in the room. Field order and units follow the Bluetooth SIG
 *  specifications (FTMS 1.0, HRS 1.0, CPS 1.1, CSCS 1.0). */

export interface IndoorBikeData {
  /** km/h */
  speed?: number;
  avgSpeed?: number;
  /** rpm */
  cadence?: number;
  avgCadence?: number;
  /** metres */
  totalDistance?: number;
  resistance?: number;
  /** watts */
  power?: number;
  avgPower?: number;
  /** kcal */
  totalEnergy?: number;
  energyPerHour?: number;
  energyPerMinute?: number;
  heartRate?: number;
  metabolicEquivalent?: number;
  /** seconds */
  elapsedTime?: number;
  remainingTime?: number;
}

/** Walks a DataView little-endian, tracking the offset. */
class Reader {
  offset = 0;
  constructor(private view: DataView) {}
  get remaining(): number { return this.view.byteLength - this.offset; }
  u8(): number { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  i8(): number { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  u24(): number {
    const a = this.u8();
    const b = this.u8();
    const c = this.u8();
    return a | (b << 8) | (c << 16);
  }
  u32(): number { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  skip(bytes: number): void { this.offset += bytes; }
}

const bit = (flags: number, n: number): boolean => (flags & (1 << n)) !== 0;

/**
 * Indoor Bike Data (0x2AD2). Note bit 0 is "More Data" and is *inverted*:
 * instantaneous speed is present when the bit is clear.
 */
export function parseIndoorBikeData(view: DataView): IndoorBikeData {
  const r = new Reader(view);
  const flags = r.u16();
  const out: IndoorBikeData = {};

  if (!bit(flags, 0) && r.remaining >= 2) out.speed = r.u16() * 0.01;
  if (bit(flags, 1) && r.remaining >= 2) out.avgSpeed = r.u16() * 0.01;
  if (bit(flags, 2) && r.remaining >= 2) out.cadence = r.u16() * 0.5;
  if (bit(flags, 3) && r.remaining >= 2) out.avgCadence = r.u16() * 0.5;
  if (bit(flags, 4) && r.remaining >= 3) out.totalDistance = r.u24();
  if (bit(flags, 5) && r.remaining >= 2) out.resistance = r.i16();
  if (bit(flags, 6) && r.remaining >= 2) out.power = r.i16();
  if (bit(flags, 7) && r.remaining >= 2) out.avgPower = r.i16();
  if (bit(flags, 8) && r.remaining >= 5) {
    out.totalEnergy = r.u16();
    out.energyPerHour = r.u16();
    out.energyPerMinute = r.u8();
  }
  if (bit(flags, 9) && r.remaining >= 1) out.heartRate = r.u8();
  if (bit(flags, 10) && r.remaining >= 1) out.metabolicEquivalent = r.u8() * 0.1;
  if (bit(flags, 11) && r.remaining >= 2) out.elapsedTime = r.u16();
  if (bit(flags, 12) && r.remaining >= 2) out.remainingTime = r.u16();

  // "Not available" is signalled as 0xFFFF / 0xFFFE by some trainers.
  if (out.power !== undefined && (out.power === 0x7fff || out.power === -1)) delete out.power;
  if (out.cadence !== undefined && out.cadence > 300) delete out.cadence;
  return out;
}

export interface HeartRateMeasurement {
  heartRate: number;
  /** undefined when the sensor does not report contact status */
  contactDetected?: boolean;
  /** kJ */
  energyExpended?: number;
  /** seconds between beats */
  rrIntervals?: number[];
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRate(view: DataView): HeartRateMeasurement {
  const r = new Reader(view);
  const flags = r.u8();
  const out: HeartRateMeasurement = { heartRate: bit(flags, 0) ? r.u16() : r.u8() };

  // Bits 1-2: 0/1 = not supported, 2 = supported but no contact, 3 = contact.
  const contact = (flags >> 1) & 0b11;
  if (contact >= 2) out.contactDetected = contact === 3;

  if (bit(flags, 3) && r.remaining >= 2) out.energyExpended = r.u16();
  if (bit(flags, 4)) {
    const rr: number[] = [];
    while (r.remaining >= 2) rr.push(r.u16() / 1024);
    if (rr.length) out.rrIntervals = rr;
  }
  return out;
}

export interface RevolutionData {
  /** cumulative revolutions */
  revolutions: number;
  /** event time in the characteristic's own tick units */
  time: number;
}

export interface CyclingPowerMeasurement {
  /** watts */
  power: number;
  /** percent of power from the left leg */
  balance?: number;
  /** Nm */
  accumulatedTorque?: number;
  wheel?: RevolutionData;
  crank?: RevolutionData;
  /** kJ */
  accumulatedEnergy?: number;
}

/** Cycling Power Measurement (0x2A63). Instantaneous power always follows the flags. */
export function parseCyclingPower(view: DataView): CyclingPowerMeasurement {
  const r = new Reader(view);
  const flags = r.u16();
  const out: CyclingPowerMeasurement = { power: r.i16() };

  if (bit(flags, 0) && r.remaining >= 1) out.balance = r.u8() * 0.5;
  if (bit(flags, 2) && r.remaining >= 2) out.accumulatedTorque = r.u16() / 32;
  if (bit(flags, 4) && r.remaining >= 6) {
    // wheel event time is 1/2048 s in this service
    out.wheel = { revolutions: r.u32(), time: r.u16() };
  }
  if (bit(flags, 5) && r.remaining >= 4) {
    out.crank = { revolutions: r.u16(), time: r.u16() };
  }
  if (bit(flags, 6) && r.remaining >= 4) r.skip(4);  // extreme force magnitudes
  if (bit(flags, 7) && r.remaining >= 4) r.skip(4);  // extreme torque magnitudes
  if (bit(flags, 8) && r.remaining >= 3) r.skip(3);  // extreme angles
  if (bit(flags, 9) && r.remaining >= 2) r.skip(2);  // top dead spot angle
  if (bit(flags, 10) && r.remaining >= 2) r.skip(2); // bottom dead spot angle
  if (bit(flags, 11) && r.remaining >= 2) out.accumulatedEnergy = r.u16();
  return out;
}

export interface CscMeasurement { wheel?: RevolutionData; crank?: RevolutionData; }

/** CSC Measurement (0x2A5B). Both event times are 1/1024 s here. */
export function parseCsc(view: DataView): CscMeasurement {
  const r = new Reader(view);
  const flags = r.u8();
  const out: CscMeasurement = {};
  if (bit(flags, 0) && r.remaining >= 6) out.wheel = { revolutions: r.u32(), time: r.u16() };
  if (bit(flags, 1) && r.remaining >= 4) out.crank = { revolutions: r.u16(), time: r.u16() };
  return out;
}

export interface FitnessMachineFeatures {
  /** the machine reports these values */
  reports: {
    averageSpeed: boolean; cadence: boolean; totalDistance: boolean; resistance: boolean;
    expendedEnergy: boolean; heartRate: boolean; elapsedTime: boolean; power: boolean;
  };
  /** the machine accepts these targets — this is what phase 3 needs */
  canSet: {
    speed: boolean; inclination: boolean; resistance: boolean; power: boolean;
    heartRate: boolean; simulation: boolean; wheelCircumference: boolean; spinDown: boolean;
  };
}

/** Fitness Machine Feature (0x2ACC): 4 bytes of machine features, 4 of targets. */
export function parseFitnessMachineFeature(view: DataView): FitnessMachineFeatures {
  const r = new Reader(view);
  const machine = r.u32();
  const target = r.remaining >= 4 ? r.u32() : 0;
  return {
    reports: {
      averageSpeed: bit(machine, 0),
      cadence: bit(machine, 1),
      totalDistance: bit(machine, 2),
      resistance: bit(machine, 7),
      expendedEnergy: bit(machine, 9),
      heartRate: bit(machine, 10),
      elapsedTime: bit(machine, 12),
      power: bit(machine, 14),
    },
    canSet: {
      speed: bit(target, 0),
      inclination: bit(target, 1),
      resistance: bit(target, 2),
      power: bit(target, 3),
      heartRate: bit(target, 4),
      simulation: bit(target, 13),
      wheelCircumference: bit(target, 14),
      spinDown: bit(target, 15),
    },
  };
}

export interface PowerRange { min: number; max: number; increment: number; }

/** Supported Power Range (0x2AD8), in watts. */
export function parseSupportedPowerRange(view: DataView): PowerRange {
  const r = new Reader(view);
  return { min: r.i16(), max: r.i16(), increment: r.u16() };
}

export function parseUtf8(view: DataView): string {
  return new TextDecoder().decode(view).replace(/\0+$/, '').trim();
}
