import { Emitter } from '../core/pubsub';
import { VAULT_URL } from './config';
import { deriveKeys, formatKey, generateKey, lastGroup, parseKey } from './key';
import { applyProfile, buildProfile, readProfile, type Profile, type ProfileStore, type SettingsHolder } from './profile';
import { open, seal } from './seal';
import { VaultClient } from './vault';

/** Where the remembered key lives: its own key, not settings, so Reset to
 *  defaults does not forget it (as with Strava's tokens). */
export const BACKUP_STORAGE_KEY = 'cycle-indoors.backup.v1';

interface Remembered {
  /** the key as the rider sees it */
  key: string;
  /** unix ms of this browser's last successful backup */
  backedUpAt?: number;
}

export interface BackupDeps {
  /** undefined when no vault is set up */
  vault: VaultClient | undefined;
  store: ProfileStore;
  settings: SettingsHolder;
  storage(): Storage | undefined;
  now(): number;
}

/** What the restore asks the rider before replacing anything, and tells them after. */
export interface RestorePrompts {
  /** the warning: true only for Replace */
  confirm(profile: Profile): Promise<boolean>;
  /** shown after a successful restore (Strava must be connected separately) */
  restored(profile: Profile): Promise<void>;
}

export type RestoreOutcome = 'none' | 'cancelled' | 'restored';

export class WrongConfirmation extends Error {
  constructor() { super('That is not the last group of the key. Check what you saved and try again.'); }
}

/** Whether this browser can do what a backup needs. */
export function cryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.deriveKey === 'function'
    && typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';
}

/**
 * The rider's backup: the recovery key, Store current profile to cloud, Retrieve profile from cloud and Delete.
 * Backing up replaces the stored backup (the last one wins); restoring
 * replaces this browser's profile (no merging). Strava's tokens, the key and
 * device settings are never part of it.
 */
export class Backup extends Emitter<{ change: void }> {
  /** a key made but not yet confirmed: not remembered, nothing uploaded */
  private pending: string | undefined;

  constructor(private readonly deps: BackupDeps) { super(); }

  get available(): boolean { return this.deps.vault !== undefined && cryptoAvailable(); }

  /** The remembered key, if any; a stored key that does not parse reads as none. */
  get key(): string | undefined { return this.remembered()?.key; }

  get backedUpAt(): number | undefined { return this.remembered()?.backedUpAt; }

  /** Makes a new key to show the rider. It is kept only once confirmed. */
  newKey(): string {
    this.pending = formatKey(generateKey());
    return this.pending;
  }

  /** The rider typed back the new key's last group: remember it and make the
   *  first backup. A wrong group throws `WrongConfirmation` and uploads nothing. */
  async confirmNewKey(typed: string): Promise<void> {
    const pending = this.pending;
    if (!pending) throw new Error('no new key to confirm');
    if (typed.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1') !== lastGroup(pending)) throw new WrongConfirmation();
    this.remember({ key: pending });
    this.pending = undefined;
    this.emit('change', undefined);
    await this.backUp();
  }

  /** A key from another browser. Throws `InvalidKey` for a mistyped one,
   *  before any request. */
  enterKey(text: string): void {
    this.remember({ key: formatKey(parseKey(text)) });
    this.pending = undefined;
    this.emit('change', undefined);
  }

  /** Forgets the key in this browser. The backup itself stays. */
  forget(): void {
    try { this.deps.storage()?.removeItem(BACKUP_STORAGE_KEY); } catch { /* nothing to forget */ }
    this.pending = undefined;
    this.emit('change', undefined);
  }

  /** Encrypts this browser's profile and replaces the stored backup with it. */
  async backUp(): Promise<number> {
    const { vault, token, encryption, remembered } = await this.session();
    const madeAt = this.deps.now();
    const profile = await buildProfile(this.deps.store, this.deps.settings.current, madeAt);
    await vault.put(token, await seal(profile, encryption));
    this.remember({ ...remembered, backedUpAt: madeAt });
    this.emit('change', undefined);
    return madeAt;
  }

  /**
   * Fetches and decrypts the backup, asks before replacing anything, then
   * makes this browser's profile exactly the backup's. Nothing local changes
   * unless the rider chooses Replace and the whole replace succeeds.
   */
  async restore(prompts: RestorePrompts): Promise<RestoreOutcome> {
    const { vault, token, encryption } = await this.session();
    const bytes = await vault.get(token);
    if (!bytes) return 'none';
    const profile = readProfile(await open(bytes, encryption));
    if (!await prompts.confirm(profile)) return 'cancelled';
    await applyProfile(profile, this.deps.store, this.deps.settings);
    this.emit('change', undefined);
    await prompts.restored(profile);
    return 'restored';
  }

  /** Deletes the stored backup. The key stays remembered. */
  async deleteBackup(): Promise<void> {
    const { vault, token, remembered } = await this.session();
    await vault.delete(token);
    this.remember({ key: remembered.key });
    this.emit('change', undefined);
  }

  private async session() {
    const vault = this.deps.vault;
    if (!vault || !cryptoAvailable()) throw new Error('Backup is unavailable in this browser.');
    const remembered = this.remembered();
    if (!remembered) throw new Error('No recovery key is set.');
    const { token, encryption } = await deriveKeys(parseKey(remembered.key));
    return { vault, token, encryption, remembered };
  }

  private remembered(): Remembered | undefined {
    try {
      const raw = this.deps.storage()?.getItem(BACKUP_STORAGE_KEY);
      if (!raw) return undefined;
      const value = JSON.parse(raw) as Partial<Remembered>;
      if (typeof value.key !== 'string') return undefined;
      parseKey(value.key);
      return { key: value.key, ...(typeof value.backedUpAt === 'number' ? { backedUpAt: value.backedUpAt } : {}) };
    } catch {
      return undefined;
    }
  }

  private remember(value: Remembered): void {
    this.deps.storage()?.setItem(BACKUP_STORAGE_KEY, JSON.stringify(value));
  }
}

/** The app's backup, over the real browser. */
export function browserBackup(store: ProfileStore, settings: SettingsHolder): Backup {
  return new Backup({
    vault: VAULT_URL ? new VaultClient(VAULT_URL) : undefined,
    store,
    settings,
    storage: () => {
      try { return globalThis.localStorage; } catch { return undefined; }
    },
    now: () => Date.now(),
  });
}
