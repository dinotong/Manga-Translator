import { noteSent, RATE_WINDOW_MS } from '../core/rate-limit';

/**
 * When each key was last used, so pacing survives both concurrency and the
 * service worker being torn down.
 *
 * Two things force this to be a module-level singleton rather than state on a
 * KeyRing instance. Jobs now run several at a time, each with its own ring, and
 * two rings that each believe they have the full 14 requests a minute would
 * together send 28. And Chrome restarts the worker constantly, so an in-memory
 * record alone would reset the window every couple of minutes and the extension
 * would rediscover the ceiling by being refused — which is the exact cost this
 * is here to avoid.
 *
 * The in-memory copy is authoritative *within* a worker lifetime and is updated
 * synchronously, which is what makes reserving a slot atomic: JavaScript does not
 * interleave, so "pick a key and mark it used" completes before any other job can
 * look. Storage is a write-behind mirror; losing the last write costs at most one
 * request's worth of accuracy.
 */
const KEY = 'geminiRateRecord';

export type RateRecord = Record<string, number[]>;

let memory: RateRecord | null = null;
let flushing: Promise<void> | null = null;

/** Load once per worker lifetime, then serve from memory. */
export async function loadRates(): Promise<RateRecord> {
  if (memory) return memory;
  const got = await chrome.storage.local.get(KEY);
  const raw = got[KEY];
  const next: RateRecord = {};
  if (raw && typeof raw === 'object') {
    for (const [id, times] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(times)) next[id] = times.filter((t): t is number => typeof t === 'number');
    }
  }
  // A second caller that arrived while the first was awaiting storage must not
  // overwrite reservations the first already made.
  memory ??= next;
  return memory;
}

/** The record as it stands right now, without touching storage. */
export function ratesNow(): RateRecord {
  return memory ?? {};
}

/**
 * Reserve a slot on a key. Synchronous on purpose — see above.
 */
export function reserve(keyId: string, now: number): void {
  memory ??= {};
  memory[keyId] = noteSent(memory[keyId] ?? [], now, RATE_WINDOW_MS);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushing) return;
  // Coalesced: a burst of reservations is one storage write, and the window is
  // a minute long so a second of staleness cannot matter.
  flushing = new Promise<void>((resolve) => {
    setTimeout(() => {
      flushing = null;
      void chrome.storage.local.set({ [KEY]: memory ?? {} }).finally(resolve);
    }, 1_000);
  });
}

/** Test seam: forget everything, including what was loaded from storage. */
export function resetRatesForTest(next: RateRecord | null = null): void {
  memory = next;
}
