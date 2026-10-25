let failures = 0;
let checks = 0;

export function check(label: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    // stdout, not stderr: a test may be capturing console.error from the app.
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

export function near(label: string, actual: number, expected: number, tolerance = 0.5): void {
  check(label, Math.abs(actual - expected) <= tolerance, `got ${actual}, expected ${expected} ±${tolerance}`);
}

export function suite(name: string, body: () => void): void {
  console.log(`\n${name}`);
  body();
}

export function report(): void {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

/**
 * Polls `get` until `done` holds, for async work a fixed wait cannot be sure
 * of outlasting (a slow CI runner takes several times longer than a laptop).
 * Gives back the last value on timeout, so the check that follows reports it.
 */
export async function until<T>(get: () => T | Promise<T>, done: (value: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (done(value) || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
