/**
 * A backup as the vault stores it:
 *
 *   byte 0      format version (1)
 *   bytes 1–12  random IV, fresh for every seal
 *   bytes 13–   AES-GCM ciphertext and its 16-byte tag, over gzip(JSON)
 *
 * The AAD ties the ciphertext to this format, and GCM's tag means a single
 * changed byte anywhere fails to open rather than decrypting to something
 * else.
 */

const VERSION = 1;
const IV_BYTES = 12;
const AAD = new TextEncoder().encode('cycle-indoors/backup/v1');

export class BackupDamaged extends Error {
  constructor() { super('The backup is damaged or was not made with this key.'); }
}

/** Every byte of a stream, as one array. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Not through `Blob`, which the jsdom tests replace with one that has no stream. */
function through(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  return drain(source.pipeThrough(transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>));
}

export async function seal(value: unknown, key: CryptoKey, random = (b: Uint8Array) => crypto.getRandomValues(b)): Promise<Uint8Array> {
  const plain = await through(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream('gzip'));
  const iv = random(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: AAD }, key, plain as BufferSource,
  ));
  const out = new Uint8Array(1 + IV_BYTES + cipher.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(cipher, 1 + IV_BYTES);
  return out;
}

/** The value a backup holds. Throws `BackupDamaged` for anything that does
 *  not open: another key, an unknown version, or a single changed byte. */
export async function open(bytes: Uint8Array, key: CryptoKey): Promise<unknown> {
  if (bytes.length < 1 + IV_BYTES + 16 || bytes[0] !== VERSION) throw new BackupDamaged();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(1, 1 + IV_BYTES), additionalData: AAD }, key, bytes.slice(1 + IV_BYTES),
    );
    const json = await through(new Uint8Array(plain), new DecompressionStream('gzip'));
    return JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new BackupDamaged();
  }
}
