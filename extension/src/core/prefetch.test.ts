import { describe, expect, it } from 'vitest';
import {
  clampLookahead,
  effectiveLookahead,
  LOOKAHEAD_WHOLE_CHAPTER,
  MAX_CONSECUTIVE_MISSES,
  MAX_LOOKAHEAD,
  MIN_PREFETCH_GAP_MS,
  nextPublished,
  pickPrefetch,
  prefetchAllowed,
  prefetchRefusal,
  readAheadLead,
  type PrefetchInput,
  type PublishedInput,
  type PublishedPage,
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
    expect(pickPrefetch(ok({ inFlight: 1, speculativeAllowance: 3 }))).toBe(6);
    expect(pickPrefetch(ok({ inFlight: 2, speculativeAllowance: 3 }))).toBe(6);
    expect(pickPrefetch(ok({ inFlight: 3, speculativeAllowance: 3 }))).toBeNull();
  });

  it('treats a missing or nonsensical batch size as one at a time', () => {
    expect(pickPrefetch(ok({ inFlight: 1 }))).toBeNull();
    expect(pickPrefetch(ok({ inFlight: 1, speculativeAllowance: 0 }))).toBeNull();
  });

  it('still refuses to add a guess while the reader is waiting, however deep', () => {
    expect(
      pickPrefetch(ok({ lookahead: LOOKAHEAD_WHOLE_CHAPTER, speculativeAllowance: 3, foregroundWaiting: true })),
    ).toBeNull();
  });

  it('still stops dead when the tab is hidden, however deep', () => {
    expect(
      pickPrefetch(ok({ lookahead: LOOKAHEAD_WHOLE_CHAPTER, speculativeAllowance: 3, visible: false })),
    ).toBeNull();
  });

  it('still respects the minimum gap, however deep', () => {
    expect(
      pickPrefetch(ok({
        lookahead: LOOKAHEAD_WHOLE_CHAPTER,
        speculativeAllowance: 3,
        lastStartAt: 100_000 - (MIN_PREFETCH_GAP_MS - 1),
      })),
    ).toBeNull();
  });
});

describe('prefetchAllowed', () => {
  // The gate `pickPrefetch` is built on, split out so that reading a URL the
  // site published answers to exactly the same rules as guessing one. Every
  // refusal below is one `pickPrefetch` already made; the point of the tests is
  // that they are the *same* rules and not a second, laxer copy.
  it('lets a healthy state through', () => {
    expect(prefetchAllowed(ok())).toBe(true);
  });

  it('refuses for each reason on its own', () => {
    expect(prefetchAllowed(ok({ enabled: false }))).toBe(false);
    expect(prefetchAllowed(ok({ lookahead: 0 }))).toBe(false);
    expect(prefetchAllowed(ok({ visible: false }))).toBe(false);
    expect(prefetchAllowed(ok({ foregroundWaiting: true }))).toBe(false);
    expect(prefetchAllowed(ok({ inFlight: 1 }))).toBe(false);
    expect(prefetchAllowed(ok({ consecutiveMisses: MAX_CONSECUTIVE_MISSES }))).toBe(false);
    expect(prefetchAllowed(ok({ lastStartAt: 100_000 - (MIN_PREFETCH_GAP_MS - 1) }))).toBe(false);
  });

  it('agrees with pickPrefetch wherever pickPrefetch has an opinion', () => {
    const states: Partial<PrefetchInput>[] = [
      {},
      { enabled: false },
      { visible: false },
      { lookahead: 0 },
      { inFlight: 3, speculativeAllowance: 3 },
      { foregroundWaiting: true },
      { consecutiveMisses: 5 },
      { lastStartAt: 100_000 },
    ];
    for (const patch of states) {
      const input = ok(patch);
      // `pickPrefetch` may still answer null for a reason of its own (nothing
      // left to cover), but it must never answer non-null when the gate is shut.
      if (!prefetchAllowed(input)) expect(pickPrefetch(input)).toBeNull();
    }
  });
});

describe('nextPublished', () => {
  /**
   * The measured shape of a luscious album on 2026-08-16: rows about 1,500 px
   * tall in a 768 px viewport, the row under the reader starting a little below
   * the top of the screen, two more mounted below it.
   */
  const strip = (patch: Partial<PublishedInput> = {}): PublishedInput => ({
    pages: [
      { page: 5, url: 'https://cdn/5.jpg', top: -1360 },
      { page: 6, url: 'https://cdn/6.jpg', top: 348 },
      { page: 7, url: 'https://cdn/7.jpg', top: 1806 },
      { page: 8, url: 'https://cdn/8.jpg', top: 3264 },
    ],
    viewportHeight: 768,
    lookahead: 3,
    covered: new Set<number>(),
    ...patch,
  });

  const url = (p: PublishedPage | null) => p?.url ?? null;

  it('takes the nearest page that is entirely below the fold', () => {
    // Page 6 is the one being read — its top is on screen — so the first page
    // the reader has not reached is 7.
    expect(url(nextPublished(strip()))).toBe('https://cdn/7.jpg');
  });

  it('walks forward as pages get covered', () => {
    expect(url(nextPublished(strip({ covered: new Set([7]) })))).toBe('https://cdn/8.jpg');
    expect(nextPublished(strip({ covered: new Set([7, 8]) }))).toBeNull();
  });

  it('never looks back at a page the reader has passed', () => {
    // Page 5 is above the viewport and page 6 straddles it. Neither is work the
    // reader is waiting for, and both are already the observer's business.
    expect(nextPublished(strip({ pages: strip().pages.slice(0, 2) }))).toBeNull();
  });

  it('honours the reader’s lookahead, counted from the reader and not from zero', () => {
    expect(url(nextPublished(strip({ lookahead: 1 })))).toBe('https://cdn/7.jpg');
    // With a depth of one, page 7 covered means there is nothing left to do —
    // page 8 is deeper than the reader asked for.
    expect(nextPublished(strip({ lookahead: 1, covered: new Set([7]) }))).toBeNull();
    expect(url(nextPublished(strip({ lookahead: 2, covered: new Set([7]) })))).toBe(
      'https://cdn/8.jpg',
    );
  });

  it('is switched off by a lookahead of 0, like every other prefetch path', () => {
    expect(nextPublished(strip({ lookahead: 0 }))).toBeNull();
    expect(nextPublished(strip({ lookahead: -1 }))).toBeNull();
  });

  it('reads the DOM order the site gave it, not the order it gave it in', () => {
    // e-hentai MPV drops decoded pages behind the reader, so the live list is
    // not guaranteed to arrive sorted after a jump.
    const shuffled = [strip().pages[3]!, strip().pages[1]!, strip().pages[2]!];
    expect(url(nextPublished(strip({ pages: shuffled })))).toBe('https://cdn/7.jpg');
  });

  it('ignores an entry the site has not finished publishing', () => {
    // A mounted row with no src yet, and a placeholder with no position. Both
    // are things the DOM really contains; neither is a URL worth fetching.
    expect(
      url(
        nextPublished(
          strip({
            pages: [
              { page: 7, url: '', top: 1806 },
              { page: 8, url: 'https://cdn/8.jpg', top: 3264 },
            ],
          }),
        ),
      ),
    ).toBe('https://cdn/8.jpg');
    expect(
      nextPublished(
        strip({ pages: [{ page: 7, url: 'https://cdn/7.jpg', top: Number.NaN }] }),
      ),
    ).toBeNull();
  });

  it('ignores an entry whose page number is not a page number', () => {
    expect(
      nextPublished(
        strip({
          pages: [
            { page: 0, url: 'https://cdn/0.jpg', top: 1806 },
            { page: 1.5, url: 'https://cdn/x.jpg', top: 1900 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('has nothing to say on a site that publishes nothing', () => {
    expect(nextPublished(strip({ pages: [] }))).toBeNull();
  });

  it('covers the mounted window one page at a time and then stops', () => {
    const covered = new Set<number>();
    const picked: number[] = [];
    for (let i = 0; i < 10; i++) {
      const next = nextPublished(strip({ covered }));
      if (next === null) break;
      picked.push(next.page);
      covered.add(next.page);
    }
    // Both sites mount a window, not the whole gallery. Two pages ahead is what
    // was measured, and it is all this may ever ask for in one position.
    expect(picked).toEqual([7, 8]);
  });
});

/**
 * "It is only a few pages ahead" is one sentence with seven possible causes,
 * and answering it by reading the gate has already produced two wrong
 * diagnoses. The refusal reason is what turns the next report into a
 * measurement, so the order it reports in is part of the contract: the cheap
 * and unambiguous checks come first, and the three throughput clauses last,
 * because those are the ones that look alike from the reader's side.
 */
describe('prefetchRefusal', () => {
  const ok = {
    now: 10_000,
    enabled: true,
    lookahead: 10,
    visible: true,
    foregroundWaiting: false,
    inFlight: 0,
    speculativeAllowance: 3,
    consecutiveMisses: 0,
    lastStartAt: 0,
  };

  it('says nothing when nothing is in the way', () => {
    expect(prefetchRefusal(ok)).toBeNull();
    expect(prefetchAllowed(ok)).toBe(true);
  });

  it('names each clause', () => {
    expect(prefetchRefusal({ ...ok, enabled: false })).toBe('disabled');
    expect(prefetchRefusal({ ...ok, lookahead: 0 })).toBe('no-lookahead');
    expect(prefetchRefusal({ ...ok, visible: false })).toBe('hidden');
    expect(prefetchRefusal({ ...ok, consecutiveMisses: MAX_CONSECUTIVE_MISSES })).toBe('bad-guesses');
    expect(prefetchRefusal({ ...ok, foregroundWaiting: true })).toBe('foreground-waiting');
    expect(prefetchRefusal({ ...ok, inFlight: 3 })).toBe('in-flight');
    expect(prefetchRefusal({ ...ok, lastStartAt: 9_900 })).toBe('too-soon');
  });

  it('is exactly the boolean, so the two cannot disagree', () => {
    for (const patch of [
      { enabled: false },
      { lookahead: 0 },
      { visible: false },
      { consecutiveMisses: 5 },
      { foregroundWaiting: true },
      { inFlight: 9 },
      { lastStartAt: 9_999 },
      {},
    ]) {
      const gate = { ...ok, ...patch };
      expect(prefetchAllowed(gate)).toBe(prefetchRefusal(gate) === null);
    }
  });

  it('reports the reader’s own settings before the throughput limits', () => {
    // Everything wrong at once. A reader who switched prefetch off must not be
    // told the pipeline is busy.
    expect(
      prefetchRefusal({ ...ok, enabled: false, lookahead: 0, inFlight: 9, foregroundWaiting: true }),
    ).toBe('disabled');
  });
});

describe('readAheadLead', () => {
  it('counts pages the reader could turn to without waiting', () => {
    expect(readAheadLead(5, new Set([6, 7, 8]))).toBe(3);
  });

  it('stops at the first gap, because that is where the reader stops', () => {
    // Three pages are ready, but page 7 is not, so the very next turn after 6
    // waits. Counting the set would call this a lead of 3 and be wrong about
    // the only thing the number is for.
    expect(readAheadLead(5, new Set([6, 8, 9]))).toBe(1);
  });

  it('is zero when the next page is not ready, however much else is', () => {
    expect(readAheadLead(5, new Set([7, 8, 9, 10]))).toBe(0);
  });

  it('is zero when the site does not tell us which page we are on', () => {
    expect(readAheadLead(null, new Set([1, 2, 3]))).toBe(0);
    expect(readAheadLead(Number.NaN, new Set([1, 2, 3]))).toBe(0);
  });

  it('terminates on a page number the set can never reach', () => {
    expect(readAheadLead(1.5, new Set([2, 3]))).toBe(0);
    expect(readAheadLead(5, new Set())).toBe(0);
  });
});
