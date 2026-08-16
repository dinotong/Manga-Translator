import { describe, expect, it } from 'vitest';
import { MAX_PAGES_PER_REQUEST } from '../core/batch';
import { MIN_PREFETCH_GAP_MS, PREFETCH_TICK_MS, SPECULATIVE_ARRIVAL_GAP_MS } from '../core/prefetch';
import { BATCH_LINGER_MS } from './read-batcher';

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
