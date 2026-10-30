/**
 * Where the published catalog lives. Public, so it is fine in source.
 *
 * The public r2.dev URL of the `cycle-indoors-catalog` bucket (docs/catalog.md:
 * Publishing the catalog). An empty string means no catalog is set up.
 * `VITE_CATALOG_URL` overrides it, which is how `npm run dev:catalog` points
 * the app at the local build in `.catalog/`.
 */
const DEFAULT_CATALOG_URL = 'https://pub-4821c98870dc4a12b6e474d06acab38a.r2.dev';

// `?.`: outside Vite (the test suite, the catalog script) there is no import.meta.env.
export const CATALOG_URL: string = import.meta.env?.VITE_CATALOG_URL ?? DEFAULT_CATALOG_URL;

/** The URL of an object in the catalog (`index.json`, `files/<sha>.zwo`), or
 *  undefined when no catalog is configured. */
export function catalogUrl(key: string, base: string = CATALOG_URL): string | undefined {
  if (!base) return undefined;
  return `${base.endsWith('/') ? base : `${base}/`}${key.replace(/^\/+/, '')}`;
}
