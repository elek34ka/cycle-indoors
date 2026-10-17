const TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

/** FIT's 16-bit nibble-table CRC (see FIT Protocol, "CRC"). */
export function crc16(bytes: Uint8Array, seed = 0): number {
  let crc = seed;
  for (const byte of bytes) {
    let tmp = TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ TABLE[byte & 0xf];
    tmp = TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ TABLE[(byte >> 4) & 0xf];
  }
  return crc & 0xffff;
}

/** FIT timestamps count seconds since 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_OFFSET = 631065600;

export function toFitTime(date: Date): number {
  return Math.round(date.getTime() / 1000) - FIT_EPOCH_OFFSET;
}

export function fromFitTime(seconds: number): Date {
  return new Date((seconds + FIT_EPOCH_OFFSET) * 1000);
}

export const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;
