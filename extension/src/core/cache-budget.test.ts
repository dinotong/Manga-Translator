import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_PAGE_ESTIMATE,
  type CacheEntry,
  type CacheLimits,
  clampCacheBytes,
  clampCachePages,
  DEFAULT_CACHE_BYTES,
  DEFAULT_CACHE_PAGES,
  estimateBytesForPages,
  MAX_CACHE_BYTES,
  MAX_CACHE_PAGES,
  MIN_CACHE_PAGES,
  normalizeCacheLimits,
  planEviction,
} from './cache-budget';
import { MAX_LOOKAHEAD } from './prefetch';

/**
 * Eviction is arithmetic that runs unattended, on a machine that is not mine,
 * against data the owner cannot inspect. Everything it decides is checked here,
 * because the alternative is finding out from "my translations keep vanishing".
 */

const MB = 1024 * 1024;

/** `n` pages, one second apart, oldest first. */
function pages(n: number, bytes = 4000, start = 1_000): CacheEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `p${String(i).padStart(3, '0')}`,
    bytes,
    lastAccessedAt: start + i * 1000,
  }));
}

/** Generous on bytes, so these cases exercise the page limit on its own. */
const LIMITS: CacheLimits = { maxPages: 20, maxBytes: 100 * MB };

describe('clampCachePages', () => {
  it('never lets the cache hold less than prefetch reads ahead', () => {
    // The whole point of the floor: a cache smaller than the lookahead evicts
    // pages that were fetched for a reader who has not reached them yet.
    expect(MIN_CACHE_PAGES).toBeGreaterThan(MAX_LOOKAHEAD);
    expect(clampCachePages(1)).toBe(MIN_CACHE_PAGES);
    expect(clampCachePages(0)).toBe(MIN_CACHE_PAGES);
    expect(clampCachePages(-40)).toBe(MIN_CACHE_PAGES);
  });

  it('caps a hand-edited storage entry rather than trusting it', () => {
    expect(clampCachePages(999_999)).toBe(MAX_CACHE_PAGES);
  });

  it('keeps the numbers a reader would actually type', () => {
    expect(clampCachePages(40)).toBe(40);
    expect(clampCachePages(200)).toBe(200);
    expect(clampCachePages('40')).toBe(40);
    expect(clampCachePages(40.4)).toBe(40);
  });

  it('falls back to the default on garbage, not to a limit', () => {
    // A value that failed to parse is not a request for the smallest cache the
    // system allows, and it is certainly not a request for the largest.
    expect(clampCachePages(undefined)).toBe(DEFAULT_CACHE_PAGES);
    expect(clampCachePages(Number.NaN)).toBe(DEFAULT_CACHE_PAGES);
    expect(clampCachePages('เยอะๆ')).toBe(DEFAULT_CACHE_PAGES);
    expect(clampCachePages(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CACHE_PAGES);
  });
});

describe('clampCacheBytes', () => {
  it('keeps the ceiling inside a range that makes sense on a laptop', () => {
    expect(clampCacheBytes(1)).toBeGreaterThanOrEqual(20 * MB);
    expect(clampCacheBytes(50 * 1024 * MB)).toBe(MAX_CACHE_BYTES);
    expect(clampCacheBytes(200 * MB)).toBe(200 * MB);
  });

  it('falls back to the default on garbage', () => {
    expect(clampCacheBytes(null)).toBe(DEFAULT_CACHE_BYTES);
    expect(clampCacheBytes('x')).toBe(DEFAULT_CACHE_BYTES);
  });
});

describe('normalizeCacheLimits', () => {
  it('fills in both halves for a record written before this setting existed', () => {
    expect(normalizeCacheLimits(undefined)).toEqual({
      maxPages: DEFAULT_CACHE_PAGES,
      maxBytes: DEFAULT_CACHE_BYTES,
    });
    expect(normalizeCacheLimits({})).toEqual({
      maxPages: DEFAULT_CACHE_PAGES,
      maxBytes: DEFAULT_CACHE_BYTES,
    });
  });

  it('keeps a page choice while repairing a broken ceiling', () => {
    expect(normalizeCacheLimits({ maxPages: 40, maxBytes: 'oops' })).toEqual({
      maxPages: 40,
      maxBytes: DEFAULT_CACHE_BYTES,
    });
  });
});

describe('estimateBytesForPages', () => {
  it('lets Options say what a page budget costs on disk', () => {
    expect(estimateBytesForPages(40)).toBe(40 * BYTES_PER_PAGE_ESTIMATE);
    // Under a megabyte for 200 pages, which is the fact that makes a generous
    // default defensible in the first place.
    expect(estimateBytesForPages(200)).toBeLessThan(MB);
  });
});

describe('planEviction — nothing to do', () => {
  it('leaves an under-budget cache completely alone', () => {
    const plan = planEviction(pages(5), pages(3, 400, 500), LIMITS);
    expect(plan.ocr).toEqual([]);
    expect(plan.translation).toEqual([]);
    expect(plan.pages).toBe(5);
  });

  it('treats exactly at the limit as inside it', () => {
    expect(planEviction(pages(20), [], LIMITS).ocr).toEqual([]);
  });

  it('copes with an empty cache', () => {
    expect(planEviction([], [], LIMITS)).toEqual({ ocr: [], translation: [], pages: 0, bytes: 0 });
  });
});

describe('planEviction — the page limit', () => {
  it('drops exactly the overflow, oldest read first', () => {
    const plan = planEviction(pages(23), [], LIMITS);
    expect(plan.ocr).toEqual(['p000', 'p001', 'p002']);
    expect(plan.pages).toBe(20);
  });

  it('leaves the reader with the number they asked for, not less', () => {
    // No eviction headroom: "40 pages" has to mean 40 pages afterwards. A pass
    // that trimmed to 80% would quietly make every choice a lie.
    for (const n of [11, 40, 200]) {
      const plan = planEviction(pages(n + 25), [], { maxPages: n, maxBytes: 100 * MB });
      expect(plan.pages).toBe(n);
      expect(plan.ocr).toHaveLength(25);
    }
  });

  it('goes by last access, not by insertion order', () => {
    // The chapter the reader is part way through is the thing worth keeping,
    // even if it was written first. `pages()` hands out ascending timestamps,
    // so the record written first here is the one read most recently.
    const entries: CacheEntry[] = [
      { key: 'written-first-but-reread', bytes: 4000, lastAccessedAt: 99_000 },
      ...pages(11),
    ];
    const plan = planEviction(entries, [], { maxPages: 11, maxBytes: 100 * MB });
    expect(plan.ocr).toEqual(['p000']);
  });

  it('is deterministic when a prefetched batch shares a timestamp', () => {
    const same: CacheEntry[] = ['c', 'a', 'b', ...pages(9).map((p) => p.key)].map((k) => ({
      key: k,
      bytes: 4000,
      lastAccessedAt: 7,
    }));
    expect(planEviction(same, [], { maxPages: 11, maxBytes: 100 * MB }).ocr).toEqual(['a']);
  });

  it('does not mutate what it was given', () => {
    const entries = pages(13);
    const before = entries.map((e) => e.key);
    planEviction(entries, [], LIMITS);
    expect(entries.map((e) => e.key)).toEqual(before);
  });

  it('clamps limits handed to it directly, so no caller can bypass the floor', () => {
    const plan = planEviction(pages(30), [], { maxPages: 1, maxBytes: 500 * MB });
    expect(plan.pages).toBe(MIN_CACHE_PAGES);
  });
});

describe('planEviction — the byte ceiling underneath', () => {
  it('evicts on bytes even when the page count fits', () => {
    // The case the ceiling exists for: records far larger than measured, so a
    // page budget that looked modest is not.
    const fat = pages(8, 30 * MB);
    const plan = planEviction(fat, [], { maxPages: 200, maxBytes: 100 * MB });
    expect(plan.ocr).toEqual(['p000', 'p001', 'p002', 'p003', 'p004']);
    expect(plan.bytes).toBeLessThanOrEqual(100 * MB);
  });

  it('counts both stores against the ceiling', () => {
    const plan = planEviction(pages(4, 10 * MB), pages(4, 10 * MB, 500), {
      maxPages: 200,
      maxBytes: 50 * MB,
    });
    expect(plan.bytes).toBeLessThanOrEqual(50 * MB);
    expect(plan.ocr.length).toBeGreaterThan(0);
  });

  it('spends the readings before it touches a single translation', () => {
    // Translations are the cheap half and the half that pays off across a
    // series. They go last, and only when nothing else is left to give.
    const plan = planEviction(pages(3, 10 * MB), pages(3, 1 * MB, 500), {
      maxPages: 200,
      maxBytes: 25 * MB,
    });
    expect(plan.ocr).toEqual(['p000']);
    expect(plan.translation).toEqual([]);
  });

  it('finally evicts translations when the readings ran out', () => {
    // Without this the pass would delete every reading it had, still be over
    // the ceiling, and do it again on the next page. Forever.
    const plan = planEviction(pages(2, 1 * MB), pages(10, 5 * MB, 500), {
      maxPages: 200,
      maxBytes: 20 * MB,
    });
    expect(plan.ocr).toHaveLength(2);
    expect(plan.translation.length).toBeGreaterThan(0);
    expect(plan.bytes).toBeLessThanOrEqual(20 * MB);
  });

  it('stops rather than looping when even an empty cache would be over', () => {
    const plan = planEviction(pages(1, 900 * MB), [], { maxPages: 200, maxBytes: 20 * MB });
    expect(plan.ocr).toHaveLength(1);
    expect(plan.pages).toBe(0);
    expect(plan.bytes).toBe(0);
  });
});

describe('planEviction — the two limits together', () => {
  it('honours whichever binds first', () => {
    const byPages = planEviction(pages(50, 1000), [], { maxPages: 20, maxBytes: 100 * MB });
    expect(byPages.pages).toBe(20);

    const byBytes = planEviction(pages(50, 5 * MB), [], { maxPages: 40, maxBytes: 100 * MB });
    expect(byBytes.pages).toBeLessThan(40);
    expect(byBytes.bytes).toBeLessThanOrEqual(100 * MB);
  });

  it('reports a total that matches what survives', () => {
    const ocr = pages(30, 2000);
    const tr = pages(5, 500, 100);
    const plan = planEviction(ocr, tr, LIMITS);
    const dropped = new Set(plan.ocr);
    const kept = ocr.filter((e) => !dropped.has(e.key));
    expect(plan.pages).toBe(kept.length);
    expect(plan.bytes).toBe(kept.length * 2000 + 5 * 500);
  });

  it('at the real defaults, a whole chapter never gets evicted', () => {
    // 45 pages is the long end of a MangaDex chapter; at the measured record
    // size the default budget does not come close to either limit.
    const chapter = pages(45, BYTES_PER_PAGE_ESTIMATE);
    const plan = planEviction(chapter, [], {
      maxPages: DEFAULT_CACHE_PAGES,
      maxBytes: DEFAULT_CACHE_BYTES,
    });
    expect(plan.ocr).toEqual([]);
    expect(plan.translation).toEqual([]);
  });
});
