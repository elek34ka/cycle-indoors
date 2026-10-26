import { personalSettings, settingsFromBackup, type PersonalSettings, type Settings } from '../core/settings';
import type { DoneMark, RideLogEntry, StoredProfile, StoredRef } from '../library/db';

/**
 * The rider's profile, as a backup holds it: references and numbers only,
 * never a file's bytes, a ride's samples, Strava's tokens or the recovery key.
 */
export interface Profile {
  format: 1;
  /** unix ms */
  madeAt: number;
  settings: PersonalSettings;
  followed?: string;
  done: DoneMark[];
  library: StoredRef[];
  rides: RideLogEntry[];
}

/** Where a profile comes from and goes back to: My library's database. */
export interface ProfileStore {
  snapshot(): Promise<StoredProfile>;
  replace(profile: StoredProfile): Promise<void>;
}

export interface SettingsHolder {
  readonly current: Readonly<Settings>;
  patch(value: Partial<Settings>): void;
}

export class NotAProfile extends Error {
  constructor() { super('The backup is not one this app can read.'); }
}

export async function buildProfile(store: ProfileStore, settings: Readonly<Settings>, now = Date.now()): Promise<Profile> {
  const stored = await store.snapshot();
  return {
    format: 1,
    madeAt: now,
    settings: personalSettings(settings as Settings),
    ...(stored.followed ? { followed: stored.followed } : {}),
    done: stored.done,
    library: stored.library,
    rides: stored.rides,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : []);

/**
 * A decrypted backup as a profile. Records without their keys are dropped
 * rather than failing the restore; anything that is not a profile at all
 * throws `NotAProfile`.
 */
export function readProfile(value: unknown): Profile {
  if (!isRecord(value) || value.format !== 1) throw new NotAProfile();
  return {
    format: 1,
    madeAt: typeof value.madeAt === 'number' ? value.madeAt : 0,
    settings: (isRecord(value.settings) ? value.settings : {}) as PersonalSettings,
    ...(typeof value.followed === 'string' && value.followed ? { followed: value.followed } : {}),
    done: list(value.done).filter((m) => typeof m.key === 'string' && typeof m.doneAt === 'number') as unknown as DoneMark[],
    library: list(value.library).filter((f) => typeof f.sha256 === 'string' && typeof f.name === 'string')
      .map(({ bytes: _, ...ref }) => ref) as unknown as StoredRef[],
    rides: list(value.rides).filter((r) => typeof r.startedAt === 'number') as unknown as RideLogEntry[],
  };
}

/** Makes this browser's profile exactly the backup's: the database first, all
 *  or nothing, then the personal settings. Device settings stay. */
export async function applyProfile(profile: Profile, store: ProfileStore, settings: SettingsHolder): Promise<void> {
  await store.replace({
    done: profile.done,
    ...(profile.followed ? { followed: profile.followed } : {}),
    library: profile.library,
    rides: profile.rides,
  });
  settings.patch(settingsFromBackup(settings.current as Settings, profile.settings));
}
