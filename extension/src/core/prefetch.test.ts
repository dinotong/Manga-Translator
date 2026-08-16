import { describe, expect, it } from 'vitest';
import {
  clampLookahead,
  effectiveLookahead,
  LOOKAHEAD_WHOLE_CHAPTER,
  MAX_CONSECUTIVE_MISSES,
  MAX_LOOKAHEAD,
  MIN_PREFETCH_GAP_MS,
  pickPrefetch,
  type PrefetchInput,
} from './prefetch';

/** A state where prefetch is allowed, so each test can break exactly one rule. */
function ok(patch: Partial<PrefetchInput> = {}): PrefetchInput {
  return {
    now: 100_000,
    enabled: true,
    lookahead: 3,
    visible: true,
    foregroundWaiting: false,
    inFlight: 0,
    consecutiveMisses: 0,
    lastStartAt: 0,
    currentPage: 5,
    totalPages: 40,
    covered: new Set<number>(),
    ...patch,
  };
}

describe('clampLookahead', () => {
  it('accepts the whole range and rounds', () => {
    expect(clampLookahead(0)).toBe(0);
    expect(clampLookahead(3)).toBe(3);
    expect(clampLookahead(10)).toBe(10);
    expect(clampLookahead(40)).toBe(40);
    expect(clampLookahead(MAX_LOOKAHEAD)).toBe(MAX_LOOKAHEAD);
    expect(clampLookahead(2.4)).toBe(2);
  });

  it('offers a whole-chapter depth that is still bounded', () => {
    expect(LOOKAHEAD_WHOLE_CHAPTER).toBe(MAX_LOOKAHEAD);
    expect(clampLookahead(LOOKAHEAD_WHOLE_CHAPTER)).toBe(LOOKAHEAD_WHOLE_CHAPTER);
  });

  it('clamps rather than trusting a hand-edited settings value', () => {
    expect(clampLookahead(-5)).toBe(0);
    expect(clampLookahead(9999)).toBe(MAX_LOOKAHEAD);
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

describe('effectiveLookahead', () => {
  it('leaves a modest depth alone when the cache is roomy', () => {
    expect(effectiveLookahead(3, 200)).toBe(3);
    expect(effectiveLookahead(40, 200)).toBe(40);
  });

  it('never reads further ahead than the cache will hold', () => {
    // Otherwise the earliest guesses are evicted before the reader reaches them
    // and the request, the quota and the GPU pass are all spent for nothing.
    expect(effectiveLookahead(LOOKAHEAD_WHOLE_CHAPTER, 20)).toBe(19);
    expect(effectiveLookahead(40, 11)).toBe(10);
  });

  it('leaves room for the page being read', () => {
    expect(effectiveLookahead(99, 1)).toBe(0);
  });

  it('stays off when the reader has switched it off, however big the cache', () => {
    expect(effectiveLookahead(0, 2000)).toBe(0);
  });

  it('never goes negative on a nonsensical cache size', () => {
    expect(effectiveLookahead(5, 0)).toBe(0);
    expect(effectiveLookahead(5, -10)).toBe(0);
  });

  it('still clamps a hand-edited depth', () => {
    expect(effectiveLookahead(99_999, 5_000)).toBe(MAX_LOOKAHEAD);
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

  it('never queues ahead of a visible page that is still waiting for a slot', () => {
    expect(pickPrefetch(ok({ foregroundWaiting: true }))).toBeNull();
  });

  it('runs while the visible page is being worked on — that is the whole point', () => {
    // The old rule was "wait until nothing is running". Measured on the real
    // site, that meant a guess could only start about a second before the reader
    // turned the page, so it was never ready in time. See D-027.
    expect(pickPrefetch(ok({ foregroundWaiting: false }))).toBe(6);
  });

  it('gives up on a gallery after two wrong guesses in a row', () => {
    expect(pickPrefetch(ok({ consecutiveMisses: 1 }))).toBe(6);
    expect(pickPrefetch(ok({ consecutiveMisses: MAX_CONSECUTIVE_MISSES }))).toBeNull();
    expect(pickPrefetch(ok({ consecutiveMisses: 7 }))).toBeNull();
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
    // The gallery is 40 pages, so a whole-chapter depth from page 5 covers 6..40.
    for (let p = 6; p <= 40; p++) covered.add(p);
    expect(pickPrefetch(ok({ lookahead: 9999, covered }))).toBeNull();
    covered.delete(31);
    expect(pickPrefetch(ok({ lookahead: 9999, covered }))).toBe(31);
  });

  it('reads the whole chapter ahead when asked, and stops at its last page', () => {
    const covered = new Set<number>();
    const picked: number[] = [];
    for (let i = 0; i < 60; i++) {
      const next = pickPrefetch(ok({ lookahead: LOOKAHEAD_WHOLE_CHAPTER, covered }));
      if (next === null) break;
      picked.push(next);
      covered.add(next);
    }
    expect(picked[0]).toBe(6);
    expect(picked.at(-1)).toBe(40);
    expect(picked.length).toBe(35);
  });

  it('a deeper lookahead never means more requests at once', () => {
    // The in-flight rule is what bounds the rate, and it does not read the
    // lookahead at all.
    expect(pickPrefetch(ok({ lookahead: LOOKAHEAD_WHOLE_CHAPTER, inFlight: 1 }))).toBeNull();
  });

  it('lets a batch stage several pages, and not one more', () => {
    // Several pages in flight so their crops can leave in one Gemini request.
    expect(pickPrefetch(ok({ inFlight: 1, batchSize: 3 }))).toBe(6);
    expect(pickPrefetch(ok({ inFlight: 2, batchSize: 3 }))).toBe(6);
    expect(pickPrefetch(ok({ inFlight: 3, batchSize: 3 }))).toBeNull();
  });

  it('treats a missing or nonsensical batch size as one at a time', () => {
    expect(pickPrefetch(ok({ inFlight: 1 }))).toBeNull();
    expect(pickPrefetch(ok({ inFlight: 1, batchSize: 0 }))).toBeNull();
  });

  it('still refuses to add a guess while the reader is waiting, however deep', () => {
    expect(
      pickPrefetch(ok({ lookahead: LOOKAHEAD_WHOLE_CHAPTER, batchSize: 3, foregroundWaiting: true })),
    ).toBeNull();
  });

  it('still stops dead when the tab is hidden, however deep', () => {
    expect(
      pickPrefetch(ok({ lookahead: LOOKAHEAD_WHOLE_CHAPTER, batchSize: 3, visible: false })),
    ).toBeNull();
  });

  it('still respects the minimum gap, however deep', () => {
    expect(
      pickPrefetch(ok({
        lookahead: LOOKAHEAD_WHOLE_CHAPTER,
        batchSize: 3,
        lastStartAt: 100_000 - (MIN_PREFETCH_GAP_MS - 1),
      })),
    ).toBeNull();
  });
});
