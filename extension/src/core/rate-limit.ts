/**
 * Pacing requests so the extension stays under Gemini's per-minute ceiling
 * instead of discovering it by being refused.
 *
 * Being refused is not free. A 429 costs the round trip that earned it and then
 * the retry delay the API dictates — measured at 30 s on the free tier — so a
 * reader who trips the limit pays roughly ten times the cost of simply having
 * waited for the next slot. Everything here exists to spend that wait *before*
 * the request rather than after it.
 *
 * The model is a sliding window, because that is what Gemini enforces: the free
 * tier allows 15 `generateContent` calls per key per minute, counted over the
 * preceding 60 seconds rather than over a wall-clock minute. A fixed-bucket
 * limiter would allow 15 at 59 s and 15 more at 61 s, which is 30 inside one
 * real minute and a guaranteed refusal.
 *
 * Pure, so the ordering can be tested without a network or a clock.
 */

/** Free-tier `generateContent` requests per key per minute. */
export const FREE_TIER_RPM = 15;

export const RATE_WINDOW_MS = 60_000;

/**
 * What we actually allow ourselves, one below the real ceiling.
 *
 * The window is enforced on Google's clock, not ours, and the two disagree by
 * however long the request spent in flight — measured at 1.3-41 s against this
 * API. Aiming exactly at 15 means the fifteenth request is a coin flip on whose
 * clock is right, and losing that flip costs a 30 s penalty. One request of
 * slack also leaves room for the Options page's "test this key" button, which
 * the reader can press at any moment and which must not be the thing that
 * pushes a read over the edge.
 */
export const PACED_RPM = FREE_TIER_RPM - 1;

export interface RateLimit {
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
}

export const DEFAULT_LIMIT: RateLimit = { limit: PACED_RPM, windowMs: RATE_WINDOW_MS };

/** Timestamps still inside the window, oldest first. */
export function recent(sent: readonly number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return sent.filter((t) => t > cutoff).sort((a, b) => a - b);
}

/**
 * The earliest instant a further request may be sent on this key.
 *
 * Returns `now` when there is room immediately. Otherwise the answer is when the
 * oldest request in the window falls out of it — that is the moment a slot frees
 * on the same sliding window the server is using.
 */
export function nextSlotAt(sent: readonly number[], now: number, cfg: RateLimit = DEFAULT_LIMIT): number {
  if (cfg.limit <= 0) return Number.POSITIVE_INFINITY;
  const live = recent(sent, now, cfg.windowMs);
  if (live.length < cfg.limit) return now;
  // live is sorted, and we need `live.length - limit + 1` of the oldest entries
  // to expire before there is room. Normally that is exactly the oldest one.
  const mustExpire = live.length - cfg.limit;
  const oldest = live[mustExpire];
  return oldest === undefined ? now : oldest + cfg.windowMs;
}

/** How long a caller would have to wait, in milliseconds. Zero means "go now". */
export function waitFor(sent: readonly number[], now: number, cfg: RateLimit = DEFAULT_LIMIT): number {
  const at = nextSlotAt(sent, now, cfg);
  return at === Number.POSITIVE_INFINITY ? at : Math.max(0, at - now);
}

/**
 * Record that a request was sent, dropping what has aged out.
 *
 * Timestamps are taken when the request *starts*, not when it finishes. Google
 * counts arrivals, and these calls were measured at 1.3-41 s, so counting on
 * completion would let fifteen slow requests all start inside one window.
 */
export function noteSent(sent: readonly number[], now: number, windowMs = RATE_WINDOW_MS): number[] {
  return [...recent(sent, now, windowMs), now];
}

/* ------------------------------------------------------------------ */
/* Choosing between keys                                               */
/* ------------------------------------------------------------------ */

export interface PacedChoice<T> {
  key: T;
  /** When this key may be used. `now` when it is free right now. */
  readyAt: number;
}

/**
 * The key that can send soonest, breaking ties in the order the user listed
 * them.
 *
 * This is the whole of "two keys means two ceilings". Each key carries its own
 * per-minute allowance, so when the first is saturated the second is not — and
 * the previous rule, which only moved on once a key was out of quota *for the
 * day*, left that second allowance completely unused during exactly the burst
 * that needed it.
 *
 * The order tiebreak matters just as much and is easy to lose. While there is
 * room on the first key, everything keeps going to the first key, so a spare
 * still behaves like a spare against the 1,000/day counter: the reader drains
 * one key and then the next, rather than burning both at half rate and losing
 * the ability to say "I have a fresh key left". Spreading happens only when
 * spreading is the only way to go faster.
 */
export function pickPaced<T>(
  keys: readonly T[],
  sentOf: (key: T) => readonly number[],
  now: number,
  cfg: RateLimit = DEFAULT_LIMIT,
): PacedChoice<T> | null {
  let best: PacedChoice<T> | null = null;
  for (const key of keys) {
    const readyAt = nextSlotAt(sentOf(key), now, cfg);
    if (best === null || readyAt < best.readyAt) best = { key, readyAt };
    if (best.readyAt <= now) break; // nothing can beat "available now"
  }
  return best;
}
