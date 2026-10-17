import { crc16, toFitTime } from './crc';
import { BASE_TYPE } from './profile';

export type BaseTypeName = keyof typeof BASE_TYPE;

export interface FieldSpec {
  num: number;
  type: BaseTypeName;
  /** null / undefined writes the base type's "invalid" pattern */
  value: number | string | null | undefined;
  /** byte length for strings (defaults to utf8 length + 1) */
  size?: number;
}

const SIZES: Record<BaseTypeName, number> = {
  enum: 1, sint8: 1, uint8: 1, sint16: 2, uint16: 2, sint32: 4, uint32: 4,
  string: 1, float32: 4, uint8z: 1, uint16z: 2, uint32z: 4, byte: 1,
};

const INVALID: Record<BaseTypeName, number> = {
  enum: 0xff, sint8: 0x7f, uint8: 0xff, sint16: 0x7fff, uint16: 0xffff,
  sint32: 0x7fffffff, uint32: 0xffffffff, string: 0, float32: 0xffffffff,
  uint8z: 0, uint16z: 0, uint32z: 0, byte: 0xff,
};

/** Writes a little-endian FIT file. Definition messages are emitted lazily:
 *  a local message number keeps its definition until the layout changes. */
export class FitEncoder {
  private bytes: number[] = [];
  private layouts = new Map<number, string>();

  private u8(v: number) { this.bytes.push(v & 0xff); }
  private u16(v: number) { this.u8(v); this.u8(v >> 8); }
  private u32(v: number) { this.u16(v); this.u16(v >>> 16); }

  private writeValue(field: FieldSpec): void {
    const size = SIZES[field.type];
    if (field.type === 'string') {
      const len = field.size ?? (new TextEncoder().encode(String(field.value ?? '')).length + 1);
      const data = new TextEncoder().encode(String(field.value ?? ''));
      for (let i = 0; i < len; i++) this.u8(i < data.length ? data[i] : 0);
      return;
    }
    const raw = field.value === null || field.value === undefined || !Number.isFinite(Number(field.value))
      ? INVALID[field.type]
      : Math.round(Number(field.value));
    if (field.type === 'float32') {
      const buf = new DataView(new ArrayBuffer(4));
      buf.setFloat32(0, Number(field.value ?? 0), true);
      for (let i = 0; i < 4; i++) this.u8(buf.getUint8(i));
      return;
    }
    if (size === 1) this.u8(raw);
    else if (size === 2) this.u16(raw);
    else this.u32(raw);
  }

  /** Emit one data message, preceded by a definition message if the layout is new. */
  message(localNum: number, globalNum: number, fields: FieldSpec[]): void {
    const signature = `${globalNum}:${fields.map((f) => `${f.num}.${f.type}.${f.size ?? ''}`).join(',')}`;
    if (this.layouts.get(localNum) !== signature) {
      this.layouts.set(localNum, signature);
      this.u8(0x40 | (localNum & 0x0f)); // definition message header
      this.u8(0);                        // reserved
      this.u8(0);                        // architecture: little endian
      this.u16(globalNum);
      this.u8(fields.length);
      for (const f of fields) {
        const size = f.type === 'string'
          ? (f.size ?? new TextEncoder().encode(String(f.value ?? '')).length + 1)
          : SIZES[f.type];
        this.u8(f.num);
        this.u8(size);
        this.u8(BASE_TYPE[f.type]);
      }
    }
    this.u8(localNum & 0x0f); // data message header
    for (const f of fields) this.writeValue(f);
  }

  /** Finish the file: prepend the header, append the CRC. */
  finish(): Uint8Array {
    const data = Uint8Array.from(this.bytes);
    const out = new Uint8Array(14 + data.length + 2);
    const view = new DataView(out.buffer);
    out[0] = 14;      // header size
    out[1] = 0x20;    // protocol version 2.0
    view.setUint16(2, 2140, true); // profile version 21.40
    view.setUint32(4, data.length, true);
    out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    view.setUint16(12, crc16(out.subarray(0, 12)), true);
    out.set(data, 14);
    view.setUint16(14 + data.length, crc16(out.subarray(0, 14 + data.length)), true);
    return out;
  }
}

export { toFitTime };
