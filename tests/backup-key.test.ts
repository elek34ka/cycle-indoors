const { generateKey, formatKey, parseKey, deriveKeys, lastGroup, base64url, InvalidKey, KEY_BYTES } = await import('../src/backup/key');
const { check, report, suite } = await import('./harness');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const bytes = generateKey();
const text = formatKey(bytes);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const rejects = (input: string) => { try { parseKey(input); return false; } catch (e) { return e instanceof InvalidKey; } };

suite('the recovery key as text', () => {
  check(`${KEY_BYTES} random bytes`, bytes.length === 32);
  check('two keys differ', !same(generateKey(), generateKey()));
  check('written ci1- then groups of six', /^ci1(-[0-9A-HJKMNP-TV-Z]{6}){9}$/.test(text), text);
  check('round trip', same(parseKey(text), bytes));
  check('lower case without separators is the same key', same(parseKey(text.toLowerCase().replace(/-/g, '')), bytes));
  check('spaces instead of dashes too', same(parseKey(text.replace(/-/g, ' ')), bytes));
  check('the prefix is optional', same(parseKey(text.slice(4)), bytes));
  check('O read as 0, I and L as 1', same(parseKey(text.replace(/0/g, 'O').replace(/1/g, 'l')), bytes));
  check('the last group is the part to type back', lastGroup(text) === text.slice(-6));
  check('all zeros and all ones round trip', same(parseKey(formatKey(new Uint8Array(32))), new Uint8Array(32))
    && same(parseKey(formatKey(new Uint8Array(32).fill(255))), new Uint8Array(32).fill(255)));
});

// Every one-symbol typo, in every position, for a handful of keys.
let typos = 0;
let caught = 0;
let swaps = 0;
let swapsCaught = 0;
for (let k = 0; k < 8; k++) {
  const compact = formatKey(generateKey()).slice(4).replace(/-/g, '');
  for (let i = 0; i < compact.length; i++) {
    for (const c of ALPHABET) {
      if (c === compact[i]) continue;
      typos++;
      if (rejects(compact.slice(0, i) + c + compact.slice(i + 1))) caught++;
    }
    if (i + 1 < compact.length && compact[i] !== compact[i + 1]) {
      swaps++;
      if (rejects(compact.slice(0, i) + compact[i + 1] + compact[i] + compact.slice(i + 2))) swapsCaught++;
    }
  }
}

suite('typos are caught before any request', () => {
  check(`every single-symbol change is rejected (${caught}/${typos})`, typos > 10_000 && caught === typos);
  check(`every swap of neighbours is rejected (${swapsCaught}/${swaps})`, swaps > 300 && swapsCaught === swaps);
  check('a missing symbol is rejected', rejects(text.slice(0, -1)));
  check('an extra symbol is rejected', rejects(`${text}0`));
  check('a letter outside the alphabet is rejected', rejects(text.slice(0, -1) + 'U'));
  check('empty is rejected', rejects(''));
});

const a = await deriveKeys(bytes);
const b = await deriveKeys(parseKey(text.toLowerCase()));
const other = await deriveKeys(generateKey());
const master = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
const encBits = new Uint8Array(await crypto.subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('cycle-indoors'), info: new TextEncoder().encode('enc/v1') }, master, 256));
let exported = true;
try { await crypto.subtle.exportKey('raw', a.encryption); } catch { exported = false; }

suite('what is derived from it', () => {
  check('the same key derives the same token', a.token === b.token);
  check('another key derives another token', a.token !== other.token);
  check('the token is 256 bits, base64url', /^[A-Za-z0-9_-]{43}$/.test(a.token), a.token);
  check('the token is not the key', a.token !== base64url(bytes));
  check('the token is not the encryption key', a.token !== base64url(encBits));
  check('the encryption key is AES-GCM, 256 bits', a.encryption.algorithm.name === 'AES-GCM'
    && (a.encryption.algorithm as AesKeyAlgorithm).length === 256);
  check('and cannot be exported', !exported && !a.encryption.extractable);
});

report();
