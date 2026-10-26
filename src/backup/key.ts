/**
 * The recovery key: 32 random bytes, the only credential a backup has. The
 * rider keeps it as text; everything the service sees is derived from it,
 * and nothing that leaves the browser can be turned back into it.
 *
 *   ci1-XXXXXX-XXXXXX-…   Crockford base32 of the bytes, then 2 check symbols
 */

export const KEY_BYTES = 32;
const PREFIX = 'ci1';
/** Crockford's alphabet: no I, L, O or U, so a key read aloud survives. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_SYMBOLS = Math.ceil((KEY_BYTES * 8) / 5); // 52
const GROUP = 6;
/** Prime, below 32², so the check fits in two symbols. A single wrong symbol
 *  shifts the sum by weight × difference, both nonzero and below the prime,
 *  so it can never cancel out; neither can two adjacent symbols swapped. */
const CHECK_MODULUS = 1021;

export class InvalidKey extends Error {
  constructor() { super('That is not a valid recovery key. Check it for typos.'); }
}

export function generateKey(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): Uint8Array {
  return random(new Uint8Array(KEY_BYTES));
}

function checksum(symbols: number[]): number {
  return symbols.reduce((sum, v, i) => (sum + (i + 1) * v) % CHECK_MODULUS, 0);
}

/** The key as the rider sees it, in groups of six. */
export function formatKey(bytes: Uint8Array): string {
  if (bytes.length !== KEY_BYTES) throw new Error(`a recovery key is ${KEY_BYTES} bytes`);
  const symbols: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    // Fewer than 5 bits are ever left over, so 12 bits hold everything.
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      symbols.push((buffer >> bits) & 31);
    }
  }
  if (bits > 0) symbols.push((buffer << (5 - bits)) & 31);
  const check = checksum(symbols);
  const text = [...symbols, check >> 5, check & 31].map((v) => ALPHABET[v]).join('');
  const groups = text.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? [];
  return [PREFIX, ...groups].join('-');
}

/**
 * The key's bytes from text the rider typed or pasted: any case, with or
 * without separators and the `ci1` prefix, O read as 0 and I or L as 1.
 * Throws `InvalidKey` for anything else, before any request is made.
 */
export function parseKey(text: string): Uint8Array {
  let compact = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  // Told apart by length, since a key's own symbols can start with C11 too.
  if (compact.length === PREFIX.length + DATA_SYMBOLS + 2 && compact.startsWith('C11')) compact = compact.slice(PREFIX.length);
  if (compact.length !== DATA_SYMBOLS + 2) throw new InvalidKey();
  const values = [...compact].map((c) => ALPHABET.indexOf(c));
  if (values.some((v) => v < 0)) throw new InvalidKey();
  const symbols = values.slice(0, DATA_SYMBOLS);
  if (checksum(symbols) !== values[DATA_SYMBOLS] * 32 + values[DATA_SYMBOLS + 1]) throw new InvalidKey();

  const bytes = new Uint8Array(KEY_BYTES);
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const v of symbols) {
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (at < KEY_BYTES) bytes[at++] = (buffer >> bits) & 0xff;
    }
  }
  // The last symbol's spare bits are always zero in a key we wrote.
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new InvalidKey();
  return bytes;
}

/** The last group of the formatted key, which the rider types back to
 *  prove they saved it. */
export function lastGroup(formatted: string): string {
  return formatted.split('-').pop() ?? '';
}

export interface DerivedKeys {
  /** sent to the vault as a bearer token; the vault keeps only its hash */
  token: string;
  /** encrypts and decrypts backups; cannot be exported from the page */
  encryption: CryptoKey;
}

const SALT = new TextEncoder().encode('cycle-indoors');
const AUTH_INFO = new TextEncoder().encode('auth/v1');
const ENC_INFO = new TextEncoder().encode('enc/v1');

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bearer token and the encryption key, each from its own HKDF `info`.
 *  No slow KDF: the input already has 256 bits of entropy. */
export async function deriveKeys(bytes: Uint8Array): Promise<DerivedKeys> {
  const master = await crypto.subtle.importKey('raw', bytes as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const tokenBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: AUTH_INFO }, master, 256);
  const encryption = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: ENC_INFO },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { token: base64url(new Uint8Array(tokenBits)), encryption };
}
