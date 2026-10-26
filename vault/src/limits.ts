// Kept out of index.ts: the Workers runtime treats every export of the main
// module as an entrypoint and refuses to start on a plain value.

/** Plenty for years of a profile's references and ride numbers, and useless
 *  for hosting files. */
export const MAX_BACKUP_BYTES = 256 * 1024;
export const BACKUP_PATH = '/v1/backup';
