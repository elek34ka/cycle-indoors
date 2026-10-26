const { seal, open, BackupDamaged } = await import('../src/backup/seal');
const { deriveKeys, generateKey } = await import('../src/backup/key');
const { check, report, suite } = await import('./harness');

const { encryption } = await deriveKeys(generateKey());
const { encryption: otherKey } = await deriveKeys(generateKey());
const MARKER = 'MARKER-ftp-250-plan:Gravel';
const profile = { format: 1, settings: { ftp: 250 }, note: MARKER, done: Array.from({ length: 500 }, (_, i) => ({ key: `catalog:workout:plans/x/${i}`, doneAt: i })) };

const sealed = await seal(profile, encryption);
const again = await seal(profile, encryption);
const opened = await open(sealed, encryption) as typeof profile;
const text = new TextDecoder('latin1').decode(sealed);

const damaged = async (bytes: Uint8Array, key = encryption) => {
  try { await open(bytes, key); return false; } catch (e) { return e instanceof BackupDamaged; }
};
let flipsCaught = 0;
const positions = [0, 1, 6, 12, 13, 40, Math.floor(sealed.length / 2), sealed.length - 17, sealed.length - 1];
for (const at of positions) {
  const bent = sealed.slice();
  bent[at] ^= 0x01;
  if (await damaged(bent)) flipsCaught++;
}
const unknownVersion = sealed.slice();
unknownVersion[0] = 2;

suite('sealing a backup', () => {
  check('opens to what went in', JSON.stringify(opened) === JSON.stringify(profile));
  check('starts with the format version', sealed[0] === 1);
  check('two seals of the same profile differ (fresh IV)', sealed.some((b, i) => b !== again[i]));
  check('compressed: 500 marks fit in a few KB', sealed.length < 8 * 1024, `${sealed.length} bytes`);
  check('no plaintext in the ciphertext', !text.includes(MARKER) && !text.includes('ftp') && !text.includes('catalog:'));
});

const wrongKey = await damaged(sealed, otherKey);
const badVersion = await damaged(unknownVersion);
const truncated = await damaged(sealed.slice(0, 20));
const empty = await damaged(new Uint8Array());

suite('a backup that does not open', () => {
  check(`any flipped byte fails (${flipsCaught}/${positions.length})`, flipsCaught === positions.length);
  check('the wrong key fails', wrongKey);
  check('an unknown version fails', badVersion);
  check('a truncated one fails', truncated);
  check('nothing at all fails', empty);
});

report();
