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
 * ## Why this moved from four
 *
 * Four was measured, and the measurement was sound when it was taken: "at a mean
 * 18 s per request, four in flight is about 13 requests a minute — just under
 * one key's paced allowance of 14 (core/rate-limit.ts)". Every word of that
 * assumes **one job is one request**.
 *
 * Batching made that false. `read-batcher.ts` packs up to `MAX_PAGES_PER_REQUEST`
 * (3) pages into a single `generateContent` call, and says so itself: "carrying
 * three pages per request triples the images without spending any more of the
 * per-minute budget". So four jobs in flight is at most about 1.3 *requests* in
 * flight — roughly 4.4 a minute against an allowance of 14. The budget was
 * holding the pipeline to a third of the rate its own justification permitted.
 *
 * This is the third time in this project a rule has outlived the thing it was
 * reasoning about: `foregroundWaiting` after the concurrency split (D-027), and
 * `onScreen` after long strips (D-035). The number was never wrong; the sentence
 * underneath it stopped being true.
 *
 * ## The arithmetic, redone with batching in it
 *
 * N jobs in flight is about N/3 requests in flight, so N/3 × (60/18) ≈ 1.1N
 * requests a minute. Against `PACED_RPM` of 14 that permits N ≈ 12 before the
 * limiter is even approached. Eight is chosen below that rather than at it,
 * because the packing is opportunistic: a page the reader is looking at goes out
 * alone by design, so the worst case is N requests rather than N/3, and there
 * the rate limiter paces the excess. Pacing costs waiting; being refused costs
 * the round trip plus a 30 s penalty, which is the trade rate-limit.ts exists to
 * make.
 *
 * What this buys the reader, which is the point: speculation may hold seven
 * pages (see `speculativeAllowance`), and seven pages against an 18 s round trip
 * delivers one about every 2.6 s, against a measured page turn of 3-4 s. Three
 * pages delivered one every 6 s, so the reader outran the pipeline and a lead
 * could never accumulate — measured as `lead=0` on a cold gallery.
 */
export const DEFAULT_MAX_IN_FLIGHT = 8;

export const MAX_IN_FLIGHT_CEILING = 12;

export function clampInFlight(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_MAX_IN_FLIGHT;
  return Math.min(MAX_IN_FLIGHT_CEILING, Math.max(1, n));
}

export function total(running: Running): number {
  return running.manual + running.foreground + running.speculative;
}

/**
 * The most speculative jobs that may be in flight when nothing else is running.
 *
 * D-032 in one expression: one slot is withheld from speculation, always, so a
 * page the reader can see never waits for a guess to finish.
 *
 * It is exported because the content script has to know the same number *before*
 * it starts a guess — the prefetch gate in core/prefetch.ts refuses once this
 * many speculative pages are in flight. That number used to be
 * `MAX_PAGES_PER_REQUEST` instead, on the reasoning that several pages must be
 * prepared at once for a batch to form at all. True, but it made the cap on
 * speculation the *batch size*, which has nothing to do with how much
 * concurrency is free, and at the old budget of four the two happened to be the
 * same number — three — so nothing looked wrong. Measured on a live read the gate
 * refused 35 of 53 ticks on `in-flight` with `speculative=3/3`, and raising the
 * budget alone would not have moved it, because the content script would have
 * gone on refusing at three.
 *
 * One definition, read by both sides, is what stops those two ceilings drifting
 * apart again — or coinciding by accident and hiding each other.
 *
 * Zero at a budget of one: with a single slot there is nothing to reserve, and
 * speculation must simply not happen.
 */
export function speculativeAllowance(maxInFlight: number): number {
  return Math.max(0, Math.max(1, maxInFlight) - 1);
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
  if (kind === 'speculative') return total(running) < speculativeAllowance(cap);
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
