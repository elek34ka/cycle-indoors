import { crc16, SEMICIRCLE_TO_DEG } from './crc';
import { BASE_TYPES, MESSAGES } from './profile';

export type FieldValue = number | string | number[] | undefined;

export interface FitMessage {
  name: string;
  globalNum: number;
  fields: Record<string, FieldValue>;
}

export interface FitFile {
  messages: FitMessage[];
  byName: Map<string, FitMessage[]>;
  /** file_id.type: 4 = activity, 5 = workout, 6 = course */
  fileType?: number;
  crcOk: boolean;
}

interface FieldLayout { num: number; size: number; baseType: number; }
interface Definition { globalNum: number; littleEndian: boolean; fields: FieldLayout[]; devFields: FieldLayout[]; }

function readRaw(view: DataView, offset: number, baseType: number, le: boolean): number {
  const info = BASE_TYPES[baseType];
  switch (info.size) {
    case 1: return info.signed ? view.getInt8(offset) : view.getUint8(offset);
    case 2: return info.signed ? view.getInt16(offset, le) : view.getUint16(offset, le);
    case 4:
      if (info.float) return view.getFloat32(offset, le);
      return info.signed ? view.getInt32(offset, le) : view.getUint32(offset, le);
    case 8:
      if (info.float) return view.getFloat64(offset, le);
      return Number(info.signed ? view.getBigInt64(offset, le) : view.getBigUint64(offset, le));
    default: return view.getUint8(offset);
  }
}

export function decodeFit(buffer: ArrayBuffer): FitFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 14) throw new Error('File is too short to be a FIT file');

  const headerSize = bytes[0];
  if (headerSize !== 12 && headerSize !== 14) throw new Error(`Unexpected FIT header size ${headerSize}`);
  const magic = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (magic !== '.FIT') throw new Error('Missing ".FIT" signature — not a FIT file');

  const dataSize = view.getUint32(4, true);
  const dataStart = headerSize;
  const dataEnd = Math.min(bytes.length - 2, dataStart + dataSize);

  let crcOk = false;
  if (bytes.length >= dataEnd + 2) {
    const expected = view.getUint16(dataEnd, true);
    crcOk = expected === 0 || crc16(bytes.subarray(0, dataEnd)) === expected;
  }

  const definitions = new Map<number, Definition>();
  const messages: FitMessage[] = [];
  let lastTimestamp: number | undefined;
  let pos = dataStart;

  const decodeField = (num: number, def: MessageDefLookup, raw: FieldValue): [string, FieldValue] => {
    const field = def?.[num];
    if (!field) return [`field_${num}`, raw];
    let value = raw;
    if (typeof value === 'number') {
      if (field.semicircles) value = value * SEMICIRCLE_TO_DEG;
      else {
        if (field.scale) value = value / field.scale;
        if (field.offset) value = value - field.offset;
      }
    }
    return [field.name, value];
  };

  while (pos < dataEnd) {
    const header = bytes[pos++];
    const compressed = (header & 0x80) !== 0;

    if (!compressed && (header & 0x40) !== 0) {
      // definition message
      const localType = header & 0x0f;
      pos++; // reserved
      const littleEndian = bytes[pos++] === 0;
      const globalNum = littleEndian ? view.getUint16(pos, true) : view.getUint16(pos, false);
      pos += 2;
      const numFields = bytes[pos++];
      const fields: FieldLayout[] = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: bytes[pos + 2] & 0x1f });
        pos += 3;
      }
      const devFields: FieldLayout[] = [];
      if ((header & 0x20) !== 0) {
        const numDev = bytes[pos++];
        for (let i = 0; i < numDev; i++) {
          devFields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: 13 });
          pos += 3;
        }
      }
      definitions.set(localType, { globalNum, littleEndian, fields, devFields });
      continue;
    }

    const localType = compressed ? (header >> 5) & 0x03 : header & 0x0f;
    const def = definitions.get(localType);
    if (!def) break; // stream out of sync; keep what we have
    const profile = MESSAGES[def.globalNum];
    const fieldDefs = profile?.fields;
    const out: Record<string, FieldValue> = {};

    for (const layout of [...def.fields, ...def.devFields]) {
      const info = BASE_TYPES[layout.baseType] ?? BASE_TYPES[13];
      if (pos + layout.size > dataEnd + 2) { pos = dataEnd; break; }

      if (layout.baseType === 7) {
        let str = '';
        for (let i = 0; i < layout.size; i++) {
          const c = bytes[pos + i];
          if (c === 0) break;
          str += String.fromCharCode(c);
        }
        const [name, value] = decodeField(layout.num, fieldDefs, str);
        if (str) out[name] = value;
      } else {
        const count = Math.max(1, Math.floor(layout.size / info.size));
        const values: number[] = [];
        for (let i = 0; i < count; i++) {
          const raw = readRaw(view, pos + i * info.size, layout.baseType, def.littleEndian);
          if (info.invalid !== null && raw === info.invalid) continue;
          values.push(raw);
        }
        if (values.length === 1) {
          const [name, value] = decodeField(layout.num, fieldDefs, values[0]);
          out[name] = value;
        } else if (values.length > 1) {
          const [name] = decodeField(layout.num, fieldDefs, values[0]);
          out[name] = values;
        }
      }
      pos += layout.size;
    }

    if (compressed) {
      const offset = header & 0x1f;
      if (lastTimestamp !== undefined) {
        lastTimestamp += (offset - (lastTimestamp & 0x1f)) & 0x1f;
        out.timestamp = lastTimestamp;
      }
    } else if (typeof out.timestamp === 'number') {
      lastTimestamp = out.timestamp;
    }

    messages.push({ name: profile?.name ?? `message_${def.globalNum}`, globalNum: def.globalNum, fields: out });
  }

  const byName = new Map<string, FitMessage[]>();
  for (const msg of messages) {
    const list = byName.get(msg.name);
    if (list) list.push(msg); else byName.set(msg.name, [msg]);
  }

  const fileId = byName.get('file_id')?.[0];
  const fileType = typeof fileId?.fields.type === 'number' ? fileId.fields.type : undefined;

  return { messages, byName, fileType, crcOk };
}

type MessageDefLookup = Record<number, { name: string; scale?: number; offset?: number; semicircles?: boolean }> | undefined;
