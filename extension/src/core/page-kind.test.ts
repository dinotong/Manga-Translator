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
