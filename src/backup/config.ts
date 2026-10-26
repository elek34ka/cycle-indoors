/**
 * Where the backup vault lives (README: Backup vault). An empty string means
 * no vault is set up, and the Backup panel says backup is unavailable.
 * `VITE_VAULT_URL` overrides it, which is how a local `wrangler dev` vault is
 * used.
 */
const DEFAULT_VAULT_URL = 'https://cycle-indoors-vault.elek34ka-cycle-indoors.workers.dev';

// `?.`: outside Vite (the test suite) there is no import.meta.env.
export const VAULT_URL: string = import.meta.env?.VITE_VAULT_URL ?? DEFAULT_VAULT_URL;
