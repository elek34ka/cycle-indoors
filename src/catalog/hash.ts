/** Hex SHA-256 of some bytes: the catalog's file keys, and the check that a
 *  downloaded file is the one the index describes. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
