import { version } from '../../package.json';

/**
 * The app's version, as riders see it in Settings. The number lives only in
 * `package.json` (a named JSON import, so only this string reaches the
 * bundle); see "Versioning" in CLAUDE.md for when it is bumped.
 */
export const APP_STAGE = 'beta';
export const APP_VERSION: string = version;

/** `beta 0.5.0` */
export function versionLabel(): string {
  return `${APP_STAGE} ${APP_VERSION}`;
}
