import { describe, expect, it } from 'vitest';
import { classifyPage, type PageShape } from './page-kind';

/**
 * Every fixture below is a real measurement taken through CDP on 2026-08-15,
 * not an invented shape. The rendered boxes are what the browser reported at
 * that viewport size, for the images the per-image scorer had already accepted.
 */
const shape = (vp: [number, number], boxes: [number, number][]): PageShape => ({
  viewport: { w: vp[0], h: vp[1] },
  candidates: boxes.map(([w, h]) => ({ w, h })),
});

describe('classifyPage — measured reader pages', () => {
  it('MangaDex chapter, fit-to-height, at four window sizes', () => {
    // The page image plus a payment logo the scorer lets through, plus two
    // preloaded next pages at 0x0.
    const cases: [[number, number], [number, number][]][] = [
      [[1920, 1080], [[771, 1080], [48, 36], [0, 0], [0, 0]]],
      [[1366, 768], [[549, 768], [48, 36], [0, 0], [0, 0]]],
      // The wide-monitor case: 30% of the width, and still the only thing there.
      [[2560, 1080], [[771, 1080], [48, 36], [0, 0], [0, 0]]],
      [[1280, 1400], [[1000, 1400], [48, 36], [0, 0], [0, 0]]],
    ];
    for (const [vp, boxes] of cases) {
      expect(classifyPage(shape(vp, boxes)), `${vp[0]}x${vp[1]}`).toBe('reader');
    }
  });

  it('imhentai /view/, one image and nothing else', () => {
    expect(classifyPage(shape([1920, 1080], [[800, 1139]]))).toBe('reader');
    expect(classifyPage(shape([2560, 1080], [[800, 1139]]))).toBe('reader');
  });

  it('mangaread.org chapter — a long strip of fifteen full-width images', () => {
    const strips: [number, number][] = Array.from({ length: 15 }, () => [720, 9775]);
    expect(classifyPage(shape([1920, 1080], strips))).toBe('reader');
    // At 2560 wide one strip measured as non-dominant; one stray is allowed.
    expect(classifyPage(shape([2560, 1080], [...strips.slice(1), [700, 400]]))).toBe('reader');
  });
});

describe('classifyPage — measured listing pages', () => {
  it('MangaDex title page: six covers, none dominant', () => {
    const covers: [number, number][] = [
      [200, 284],
      [196, 279],
      [196, 279],
      [196, 279],
      [196, 279],
      [48, 36],
    ];
    expect(classifyPage(shape([1920, 1080], covers))).toBe('listing');
    expect(classifyPage(shape([1366, 768], covers))).toBe('listing');
  });

  it('MangaDex front page: a hero carousel that does dominate, drowned by covers', () => {
    // This is the case a dominance-only rule gets wrong. Three carousel slides
    // cover 86% of the width; eight covers sit underneath them.
    const boxes: [number, number][] = [
      [1654, 660],
      [1654, 660],
      [1654, 660],
      ...(Array.from({ length: 7 }, () => [215, 307]) as [number, number][]),
      [48, 36],
    ];
    expect(classifyPage(shape([1920, 1080], boxes))).toBe('listing');
  });

  it('imhentai gallery listing in a narrow window, where the cover scores as a page', () => {
    // At 921px wide the cover passes the per-image scorer. It is still 38% of
    // the width and 54% of the height, so it does not dominate.
    expect(classifyPage(shape([921, 920], [[348, 496]]))).toBe('listing');
  });

  it('mangaread.org front page: four sidebar thumbnails with big intrinsic sizes', () => {
    const thumbs: [number, number][] = [
      [65, 81],
      [65, 91],
      [65, 81],
      [65, 91],
    ];
    expect(classifyPage(shape([1920, 1080], thumbs))).toBe('listing');
  });

  it('a page with no candidates at all', () => {
    expect(classifyPage(shape([1920, 1080], []))).toBe('listing');
  });
});

describe('classifyPage — when we cannot tell', () => {
  it('says listing while nothing has been laid out yet', () => {
    // MangaDex inserts its page elements before the blob decodes. Answering
    // "reader" here would be a guess; the caller asks again after `load`.
    expect(classifyPage(shape([1920, 1080], [[0, 0], [0, 0]]))).toBe('listing');
  });

  it('says listing when the viewport has no size', () => {
    expect(classifyPage(shape([0, 0], [[800, 1200]]))).toBe('listing');
  });

  it('a single dominant image beside three bystanders is a listing', () => {
    // Three is over the budget of two. This is the deliberate bias: a reader
    // page with a chapter-thumbnail rail loses automatic translation and keeps
    // the right-click.
    const boxes: [number, number][] = [
      [1400, 1000],
      [200, 280],
      [200, 280],
      [200, 280],
    ];
    expect(classifyPage(shape([1920, 1080], boxes))).toBe('listing');
    expect(classifyPage(shape([1920, 1080], boxes.slice(0, 3)))).toBe('reader');
  });
});

/**
 * Long-strip galleries, measured through CDP on 2026-08-16.
 *
 * These are the pages the owner reported as "translation cannot keep up". They
 * were in fact not being translated at all: the album carries a recommendation
 * rail far below the reader, and counting it made every album a listing.
 */
const placed = (
  vp: [number, number],
  boxes: [number, number, number][],
): PageShape => ({
  viewport: { w: vp[0], h: vp[1] },
  candidates: boxes.map(([w, h, top]) => ({ w, h, top })),
});

describe('classifyPage — long strip with a recommendation rail', () => {
  // luscious.net album reader at 1592x768, measured at three scroll positions.
  // Pages: 1014x1434 within +-3000 px. Rail: nine 140x200 thumbnails, measured
  // at top=26937..54435 — between 35 and 71 screens below the reader.
  const rail = (top: number): [number, number, number][] =>
    Array.from({ length: 9 }, () => [140, 200, top]);

  it('reads an album as a reader page at the top of the strip', () => {
    expect(
      classifyPage(
        placed([1592, 768], [
          [1014, 1434, 150],
          [1014, 1434, 1644],
          [1014, 1434, 3139],
          ...rail(54435),
        ]),
      ),
    ).toBe('reader');
  });

  it('still reads as a reader page in the middle of the strip', () => {
    expect(
      classifyPage(
        placed([1592, 768], [
          [1014, 1434, -1958],
          [1014, 1434, -463],
          [1014, 1434, 1031],
          [1014, 1434, 2775],
          ...rail(26937),
        ]),
      ),
    ).toBe('reader');
  });

  it('was a listing before the distance rule — the regression this fixes', () => {
    // The same page with the rail's position unknown is exactly the old input,
    // and it still classifies the old way. That is the behaviour being narrowed,
    // not removed.
    expect(
      classifyPage({
        viewport: { w: 1592, h: 768 },
        candidates: [
          { w: 1014, h: 1434 },
          { w: 1014, h: 1434 },
          { w: 1014, h: 1434 },
          ...Array.from({ length: 9 }, () => ({ w: 140, h: 200 })),
        ],
      }),
    ).toBe('listing');
  });

  it('becomes a listing again once the reader scrolls down to the rail', () => {
    // At the very bottom of the album the rail is what is on screen, and there
    // is no page dominating it. Nothing there is worth translating.
    expect(
      classifyPage(placed([1592, 768], [[1014, 1434, -4000], ...rail(120)])),
    ).toBe('listing');
  });

  it('e-hentai MPV: pages at natural size stacked in a pane', () => {
    // Measured: 1280x1808 images at 1592x768, tops 640 and 2474 in range,
    // the rest scrolled far past or far ahead.
    expect(
      classifyPage(
        placed([1592, 768], [
          [1280, 1808, -10364],
          [1280, 1808, -3028],
          [1280, 1808, 640],
          [1280, 1808, 2474],
          [1280, 1808, 11644],
        ]),
      ),
    ).toBe('reader');
  });

  it('keeps MangaDex’s front page a listing — its covers share the screen', () => {
    // The hero carousel dominates, but the eight covers are right there with it,
    // so distance changes nothing about this case.
    expect(
      classifyPage(
        placed([1920, 1080], [
          [1650, 420, 90],
          ...Array.from({ length: 8 }, (_, i): [number, number, number] => [180, 256, 560 + (i % 2) * 40]),
        ]),
      ),
    ).toBe('listing');
  });

  it('ignores a rail exactly one pixel beyond the evidence range', () => {
    const vp: [number, number] = [1000, 800];
    const margin = 800 * 2;
    const justOut = 800 + margin; // top === viewportHeight + margin is out
    expect(
      classifyPage(placed(vp, [[900, 1200, 0], ...Array.from({ length: 9 }, (): [number, number, number] => [100, 140, justOut])])),
    ).toBe('reader');
    expect(
      classifyPage(placed(vp, [[900, 1200, 0], ...Array.from({ length: 9 }, (): [number, number, number] => [100, 140, justOut - 1])])),
    ).toBe('listing');
  });

  it('counts a tall candidate whose top is far above but whose body is on screen', () => {
    // A webtoon strip taller than three screens: its top is way off, but the
    // reader is looking at the middle of it.
    expect(
      classifyPage(placed([1000, 800], [[900, 9000, -4000]])),
    ).toBe('reader');
  });
});
