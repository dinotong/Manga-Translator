import { describe, expect, it } from 'vitest';
import { MAX_PAGES_PER_REQUEST } from '../core/batch';
import { MIN_PREFETCH_GAP_MS, PREFETCH_TICK_MS, SPECULATIVE_ARRIVAL_GAP_MS } from '../core/prefetch';
import { BATCH_LINGER_MS, remainingLinger } from './read-batcher';

/**
 * The window has to outlast the arrival rate, or batching cannot happen.
 *
 * Measured on a live read, a 700 ms window expired at `lingered≈705ms` carrying
 * one page, again and again, because speculative pages cannot arrive closer than
 * 750 ms apart. The relationship between those two numbers is the whole bug, and
 * nothing in the type system notices when one of them moves.
 */
describe('BATCH_LINGER_MS', () => {
  it('is long enough for a full batch to physically assemble', () => {
    // The first page starts the timer; the rest have to arrive before it fires.
    const needed = (MAX_PAGES_PER_REQUEST - 1) * SPECULATIVE_ARRIVAL_GAP_MS;
    expect(BATCH_LINGER_MS).toBeGreaterThanOrEqual(needed);
  });

  it('accounts for the tick, not just the politeness gap', () => {
    // The gap is checked on a tick, so a start refused for being fractionally
    // early waits a further whole tick. Sizing the window off MIN_PREFETCH_GAP_MS
    // alone is what produced a window just *under* one arrival gap.
    expect(SPECULATIVE_ARRIVAL_GAP_MS).toBe(MIN_PREFETCH_GAP_MS + PREFETCH_TICK_MS);
    expect(BATCH_LINGER_MS).toBeGreaterThan(
      (MAX_PAGES_PER_REQUEST - 1) * MIN_PREFETCH_GAP_MS,
    );
  });

  it('stays small against the round trip it is trying to save', () => {
    // Measured requests ran 2.8-50 s. A window anywhere near that would be
    // spending the reader's time to save our own request count, which is the
    // wrong trade — and the IntersectionObserver's lead is only ~12 s.
    expect(BATCH_LINGER_MS).toBeLessThan(3_000);
  });
});

describe('remainingLinger', () => {
  it('gives a leftover page only what is left of its own window', () => {
    // Queued at 0, flushed without a seat at 1500: it has already served its
    // whole window and must go now, not wait another one.
    expect(remainingLinger(0, BATCH_LINGER_MS)).toBe(0);
  });

  it('never re-arms for longer than the window itself', () => {
    for (const waited of [0, 100, 700, 1499, 1500, 5000]) {
      const left = remainingLinger(0, waited);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(BATCH_LINGER_MS);
    }
  });

  it('bounds total wait at BATCH_LINGER_MS from when the page was queued', () => {
    // The promise the file header makes. Measured at 3011 ms against a 1500 ms
    // window before the leftovers stopped getting a fresh timer.
    const queuedAt = 250;
    const firstFlush = 1500;
    const goesAt = firstFlush + remainingLinger(queuedAt, firstFlush);
    expect(goesAt - queuedAt).toBeLessThanOrEqual(BATCH_LINGER_MS);
  });
});
