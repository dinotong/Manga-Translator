import { describe, expect, it } from 'vitest';
import {
  cropId,
  DEFAULT_CAPS,
  MAX_PAGES_PER_REQUEST,
  pageHeader,
  parseCropId,
  planBatch,
  routeGroups,
  routeItems,
} from './batch';

const page = (id: string, crops: number, bytes = 10_000) => ({ id, crops, bytes });

describe('planBatch', () => {
  it('takes nothing from an empty queue', () => {
    expect(planBatch([])).toEqual([]);
  });

  it('stops at the page cap', () => {
    const q = Array.from({ length: 10 }, (_, i) => page(`p${i}`, 3));
    expect(planBatch(q).length).toBe(MAX_PAGES_PER_REQUEST);
  });

  it('stops at the crop cap', () => {
    const q = [page('a', 20), page('b', 20), page('c', 20)];
    expect(planBatch(q, { ...DEFAULT_CAPS, maxCrops: 24 }).map((p) => p.id)).toEqual(['a']);
  });

  it('stops at the byte cap', () => {
    const q = [page('a', 2, 2_000_000), page('b', 2, 2_000_000)];
    expect(planBatch(q, { ...DEFAULT_CAPS, maxBytes: 3_000_000 }).map((p) => p.id)).toEqual(['a']);
  });

  it('always sends the first page even when it alone breaks every cap', () => {
    // Deferring it would leave that page untranslatable for good, which is
    // strictly worse than the single-page request it would have had anyway.
    const q = [page('huge', 100, 99_000_000), page('b', 1, 10)];
    expect(planBatch(q).map((p) => p.id)).toEqual(['huge']);
  });

  it('is a prefix, never a subset — page order is reading order', () => {
    // `c` would fit alongside `a`, but taking it would translate page 3 before
    // page 2 and leave the reader looking at an untranslated page in between.
    const q = [page('a', 20), page('b', 5), page('c', 1)];
    const got = planBatch(q, { ...DEFAULT_CAPS, maxCrops: 22 });
    expect(got.map((p) => p.id)).toEqual(['a']);
  });
});

describe('cropId / parseCropId', () => {
  it('round-trips', () => {
    expect(parseCropId(cropId(0, 0))).toEqual({ page: 0, block: 0 });
    expect(parseCropId(cropId(2, 7))).toEqual({ page: 2, block: 7 });
  });

  it('is 1-based on the wire, because the model is asked for 1-based indices', () => {
    expect(cropId(0, 0)).toBe('p1b1');
  });

  it('rejects anything it did not write', () => {
    for (const bad of ['', '1', 'p1', 'b1', 'pXb1', 'p1b', 'p0b0x', null, undefined, 7, {}]) {
      expect(parseCropId(bad as unknown)).toBeNull();
    }
  });

  it('accepts surrounding whitespace, which models add', () => {
    expect(parseCropId(' p2b3 ')).toEqual({ page: 1, block: 2 });
  });

  it('rejects p0/b0 rather than reading them as -1', () => {
    expect(parseCropId('p0b1')).toBeNull();
    expect(parseCropId('p1b0')).toBeNull();
  });
});

describe('routeItems', () => {
  it('routes a three-page batch by id, not by order', () => {
    const items = [
      { id: 'p3b1', src: 'c1', out: 'C1' },
      { id: 'p1b2', src: 'a2', out: 'A2' },
      { id: 'p1b1', src: 'a1', out: 'A1' },
      { id: 'p2b1', src: 'b1', out: 'B1' },
    ];
    const { perPage, missed } = routeItems([2, 1, 1], items);
    expect(perPage[0]).toEqual([
      { src: 'a1', out: 'A1' },
      { src: 'a2', out: 'A2' },
    ]);
    expect(perPage[1]).toEqual([{ src: 'b1', out: 'B1' }]);
    expect(perPage[2]).toEqual([{ src: 'c1', out: 'C1' }]);
    expect(missed).toEqual([]);
  });

  it('shuffling the reply changes nothing', () => {
    const items = [
      { id: 'p1b1', src: 'a', out: 'A' },
      { id: 'p2b1', src: 'b', out: 'B' },
    ];
    const straight = routeItems([1, 1], items);
    const shuffled = routeItems([1, 1], [...items].reverse());
    expect(shuffled.perPage).toEqual(straight.perPage);
  });

  it('never lets one page’s text land on another when ids are absent', () => {
    // The failure this whole file exists to prevent. Two pages, no ids: the old
    // positional reading would have put page 1's second bubble onto page 2.
    const { perPage, missed } = routeItems([2, 2], [
      { src: 'a1', out: 'A1' },
      { src: 'a2', out: 'A2' },
      { src: 'b1', out: 'B1' },
      { src: 'b2', out: 'B2' },
    ]);
    expect(perPage).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(missed).toEqual([0, 1]);
  });

  it('still falls back to position for a lone page whose counts match', () => {
    const { perPage, missed } = routeItems([2], [
      { src: 'a1', out: 'A1' },
      { src: 'a2', out: 'A2' },
    ]);
    expect(perPage[0]).toEqual([
      { src: 'a1', out: 'A1' },
      { src: 'a2', out: 'A2' },
    ]);
    expect(missed).toEqual([]);
  });

  it('refuses the positional fallback when a lone page’s counts disagree', () => {
    const { perPage } = routeItems([3], [{ src: 'a', out: 'A' }]);
    expect(perPage[0]).toEqual([null, null, null]);
  });

  it('drops ids for pages that were never sent', () => {
    const { perPage, missed } = routeItems([1], [
      { id: 'p9b1', src: 'x', out: 'X' },
      { id: 'p1b1', src: 'a', out: 'A' },
    ]);
    expect(perPage[0]).toEqual([{ src: 'a', out: 'A' }]);
    expect(missed).toEqual([]);
  });

  it('drops a block index past the end of its page', () => {
    const { perPage } = routeItems([1], [{ id: 'p1b5', src: 'x', out: 'X' }]);
    expect(perPage[0]).toEqual([null]);
  });

  it('keeps the first answer when an id is repeated', () => {
    const { perPage } = routeItems([1], [
      { id: 'p1b1', src: 'first', out: 'F' },
      { id: 'p1b1', src: 'second', out: 'S' },
    ]);
    expect(perPage[0]).toEqual([{ src: 'first', out: 'F' }]);
  });

  it('reports only the pages the reply ignored entirely', () => {
    const { perPage, missed } = routeItems([2, 2], [
      { id: 'p1b1', src: 'a', out: 'A' },
    ]);
    expect(perPage[0]).toEqual([{ src: 'a', out: 'A' }, null]);
    expect(missed).toEqual([1]);
  });

  it('treats a page with no crops as neither answered nor missed', () => {
    const { perPage, missed } = routeItems([0, 1], [{ id: 'p2b1', src: 'b', out: 'B' }]);
    expect(perPage[0]).toEqual([]);
    expect(missed).toEqual([]);
  });

  it('coerces non-string src/out rather than trusting the model', () => {
    const { perPage } = routeItems([1], [{ id: 'p1b1', src: 42, out: null }]);
    expect(perPage[0]).toEqual([{ src: '', out: '' }]);
  });
});

describe('pageHeader', () => {
  it('names the id range so the model has no reason to invent one', () => {
    expect(pageHeader(1, 3, 3)).toContain('p2b1..p2b3');
  });

  it('tells the model not to carry context over the boundary', () => {
    expect(pageHeader(0, 1, 2).toLowerCase()).toContain('do not carry context');
  });

  it('reads naturally for a single bubble', () => {
    expect(pageHeader(0, 1, 1)).toContain('1 image is a bubble');
    expect(pageHeader(0, 2, 1)).toContain('2 images are bubbles');
  });
});

describe('routeGroups', () => {
  it('puts a group on the page its ids name', () => {
    const groups = routeGroups([3, 2], [{ ids: ['p2b1', 'p2b2'], src: 'あい', out: 'ก' }]);
    expect(groups[0]).toEqual([]);
    expect(groups[1]).toEqual([{ blocks: [0, 1], src: 'あい', out: 'ก' }]);
  });

  it('drops a group whose ids straddle two pages', () => {
    // Pages in one request are unrelated books; a sentence cannot run between
    // them, so the claim is discarded rather than trimmed to one page.
    const groups = routeGroups([2, 2], [{ ids: ['p1b1', 'p2b1'], src: 'x', out: 'y' }]);
    expect(groups).toEqual([[], []]);
  });

  it('drops a group naming a crop that was never sent', () => {
    expect(routeGroups([2], [{ ids: ['p1b1', 'p1b5'] }])).toEqual([[]]);
  });

  it('drops a group with an unreadable id rather than using the rest', () => {
    expect(routeGroups([3], [{ ids: ['p1b1', 'nonsense'] }])).toEqual([[]]);
    expect(routeGroups([3], [{ ids: 'p1b1' }])).toEqual([[]]);
    expect(routeGroups([3], [{}])).toEqual([[]]);
  });

  it('needs two distinct crops to be a group at all', () => {
    expect(routeGroups([3], [{ ids: ['p1b1'] }])).toEqual([[]]);
    expect(routeGroups([3], [{ ids: ['p1b2', 'p1b2'] }])).toEqual([[]]);
    expect(routeGroups([3], [{ ids: [] }])).toEqual([[]]);
  });

  it('sorts members into reading order and tolerates missing text', () => {
    expect(routeGroups([4], [{ ids: ['p1b3', 'p1b1', 'p1b2'] }])).toEqual([
      [{ blocks: [0, 1, 2], src: '', out: '' }],
    ]);
  });

  it('keeps several groups on one page', () => {
    const groups = routeGroups(
      [5],
      [
        { ids: ['p1b1', 'p1b2'], src: 'a', out: 'A' },
        { ids: ['p1b4', 'p1b5'], src: 'b', out: 'B' },
      ],
    );
    expect(groups[0]).toHaveLength(2);
  });

  it('returns one empty list per page when the model proposes nothing', () => {
    expect(routeGroups([2, 3, 1], [])).toEqual([[], [], []]);
  });
});
