/**
 * Who gets to run next, and how many things may run at once.
 *
 * ## The measurement this exists because of
 *
 * A job is: fetch the image, detect text regions on the GPU, then ask Gemini to
 * read and translate them. Measured on a real read, the detector takes
 * **126-481 ms** and the Gemini call takes **1.3-41 s**, mean 18 s. So roughly
 * 97% of a job is waiting on somebody else's server.
 *
 * Everything used to be serialised end to end — one global chain in the service
 * worker, and `maxConcurrentOcr: 1` in the content script holding its slot until
 * the worker replied. That is a sound rule applied to the wrong thing. It was
 * written to protect the detector, which genuinely cannot run twice at once
 * (D-013: ONNX sessions are not re-entrant), but it ended up serialising the
 * network wait as well. The result was a pipeline that translated 2.0 images per
 * minute while the GPU sat idle 97% of the time and the request budget ran at a
 * sixth of its allowance.
 *
 * So the two limits are separated. Detection stays strictly one at a time.
 * Waiting on Gemini does not.
 *
 * ## Why speculation gets a smaller allowance than its share
 *
 * A prefetch is a guess. It is worth making — a guessed page that the reader
 * arrives at is the difference between an instant page turn and a fifteen second
 * one — but it must never be the reason the reader waits. One slot is therefore
 * permanently withheld from speculation, so a page the reader is actually
 * looking at can always start immediately, and the queue is ordered by intent so
 * that when a slot does free, the explicit request takes it.
 */

export type WorkKind = 'manual' | 'foreground' | 'speculative';

export interface Running {
  manual: number;
  foreground: number;
  speculative: number;
}

export const NOTHING_RUNNING: Running = { manual: 0, foreground: 0, speculative: 0 };

/**
 * Whole jobs in flight at once, across every tab.
 *
 * Four, from the measured shape of a job rather than from taste. At a mean 18 s
 * per request, four in flight is a ceiling of about 13 requests a minute — just
 * under one key's paced allowance of 14 (core/rate-limit.ts), so the common
 * single-key setup saturates its own quota without ever being refused, and a
 * second key raises the useful ceiling rather than sitting idle. Going higher
 * would mostly queue requests behind the rate limiter, where the waiting is
 * invisible and does nothing but hold image bytes in memory.
 */
export const DEFAULT_MAX_IN_FLIGHT = 4;

export const MAX_IN_FLIGHT_CEILING = 8;

export function clampInFlight(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_MAX_IN_FLIGHT;
  return Math.min(MAX_IN_FLIGHT_CEILING, Math.max(1, n));
}

export function total(running: Running): number {
  return running.manual + running.foreground + running.speculative;
}

/**
 * May a job of this kind start right now?
 *
 * Speculation is held one slot below everyone else. That single reserved slot is
 * the whole guarantee: whatever the prefetcher is doing, a page the reader can
 * see never has to wait for a guess to finish first.
 */
export function canAdmit(kind: WorkKind, running: Running, maxInFlight: number): boolean {
  const cap = Math.max(1, maxInFlight);
  if (total(running) >= cap) return false;
  // The reserve is on the *total*, not on the speculative count. Counting only
  // guesses would let one foreground job plus the full speculative allowance
  // fill every slot, and the next page the reader reached would wait behind a
  // guess after all — which is the exact thing being ruled out.
  if (kind === 'speculative') return total(running) < cap - 1;
  return true;
}

/**
 * Order two queued jobs. Negative means `a` runs first.
 *
 * Intent outranks position, always. The previous ordering was distance from the
 * middle of the viewport and nothing else, which meant a right-click — the one
 * unambiguous instruction the reader can give — took its turn by screen position
 * among pages the extension had queued on its own guess.
 *
 * Distance survives as the tiebreak *within* a kind, where it is the right
 * answer: among several pages the reader can see, the nearest one is the one
 * they are looking at.
 */
export function compareWork(
  a: { kind: WorkKind; distance: number },
  b: { kind: WorkKind; distance: number },
): number {
  const rank = (k: WorkKind) => (k === 'manual' ? 0 : k === 'foreground' ? 1 : 2);
  return rank(a.kind) - rank(b.kind) || a.distance - b.distance;
}

/**
 * The next job to start, or null if nothing may start.
 *
 * Skips past work that cannot be admitted rather than stopping at it: with the
 * speculation reserve full, a queue whose head is a guess must still let the
 * reader's own page through.
 */
export function nextToRun<T extends { kind: WorkKind; distance: number }>(
  queued: readonly T[],
  running: Running,
  maxInFlight: number,
): T | null {
  const ordered = [...queued].sort(compareWork);
  return ordered.find((job) => canAdmit(job.kind, running, maxInFlight)) ?? null;
}
