import { describe, expect, it } from 'vitest';
import { clampLookahead, MIN_PREFETCH_GAP_MS, pickPrefetch, type PrefetchInput } from './prefetch';

/** A state where prefetch is allowed, so each test can break exactly one rule. */
function ok(patch: Partial<PrefetchInput> = {}): PrefetchInput {
  return {
    now: 100_000,
    enabled: true,
    lookahead: 3,
    visible: true,
    idle: true,
    inFlight: 0,
    lastStartAt: 0,
    currentPage: 5,
    totalPages: 40,
    covered: new Set<number>(),
    ...patch,
  };
}

describe('clampLookahead', () => {
  it('accepts 0..10 and rounds', () => {
    expect(clampLookahead(0)).toBe(0);
    expect(clampLookahead(3)).toBe(3);
    expect(clampLookahead(10)).toBe(10);
    expect(clampLookahead(2.4)).toBe(2);
  });

  it('clamps rather than trusting a hand-edited settings value', () => {
    expect(clampLookahead(-5)).toBe(0);
    expect(clampLookahead(999)).toBe(10);
    expect(clampLookahead('abc')).toBe(0);
    expect(clampLookahead(undefined)).toBe(0);
  });

  it('falls to 0, not 10, on a value that is not a number at all', () => {
    // Infinity and NaN mean the setting is corrupt. Reading that as "the most
    // aggressive prefetch allowed" would turn a broken value into a burst of
    // requests at someone else's server; off is the only safe reading.
    expect(clampLookahead(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampLookahead(Number.NaN)).toBe(0);
    expect(clampLookahead(null)).toBe(0);
  });
});

describe('pickPrefetch', () => {
  it('picks the very next page first', () => {
    expect(pickPrefetch(ok())).toBe(6);
  });

  it('walks forward as pages get covered, up to the lookahead and no further', () => {
    expect(pickPrefetch(ok({ covered: new Set([6]) }))).toBe(7);
    expect(pickPrefetch(ok({ covered: new Set([6, 7]) }))).toBe(8);
    expect(pickPrefetch(ok({ covered: new Set([6, 7, 8]) }))).toBeNull();
  });

  it('lookahead 0 disables the feature completely', () => {
    expect(pickPrefetch(ok({ lookahead: 0 }))).toBeNull();
  });

  it('never runs more than one speculative request at a time', () => {
    expect(pickPrefetch(ok({ inFlight: 1 }))).toBeNull();
  });

  it('keeps at least 500 ms between starts', () => {
    expect(pickPrefetch(ok({ lastStartAt: 100_000 - (MIN_PREFETCH_GAP_MS - 1) }))).toBeNull();
    expect(pickPrefetch(ok({ lastStartAt: 100_000 - MIN_PREFETCH_GAP_MS }))).toBe(6);
  });

  it('stops the moment the tab is hidden', () => {
    expect(pickPrefetch(ok({ visible: false }))).toBeNull();
  });

  it('never queues ahead of the page the reader is looking at', () => {
    expect(pickPrefetch(ok({ idle: false }))).toBeNull();
  });

  it('does nothing when auto translate is off', () => {
    expect(pickPrefetch(ok({ enabled: false }))).toBeNull();
  });

  it('does not run past the end of the gallery', () => {
    expect(pickPrefetch(ok({ currentPage: 39, totalPages: 40 }))).toBe(40);
    expect(pickPrefetch(ok({ currentPage: 40, totalPages: 40 }))).toBeNull();
  });

  it('still works when the total is unknown', () => {
    expect(pickPrefetch(ok({ totalPages: null }))).toBe(6);
  });

  it('does nothing on a site with no page number', () => {
    expect(pickPrefetch(ok({ currentPage: null }))).toBeNull();
  });

  it('honours a clamped lookahead rather than an absurd stored one', () => {
    const covered = new Set<number>();
    for (let p = 6; p <= 15; p++) covered.add(p);
    // 999 clamps to 10, so pages 6..15 are the whole allowance.
    expect(pickPrefetch(ok({ lookahead: 999, covered }))).toBeNull();
    covered.delete(15);
    expect(pickPrefetch(ok({ lookahead: 999, covered }))).toBe(15);
  });
});
