import { describe, expect, it } from 'vitest';
import {
  GLYPH_EM,
  MAX_FONT_CQW,
  MIN_FONT_CQW,
  MIN_READABLE_PX,
  fitFont,
  glyphCount,
  longestWordGlyphs,
  plateFromCentre,
} from './font-fit';

describe('glyphCount', () => {
  it('counts a Thai consonant with stacked vowel and tone mark as one', () => {
    expect('ที่'.length).toBe(3);
    expect(glyphCount('ที่')).toBe(1);
  });

  it('counts a Thai phrase by cells, not code units', () => {
    // นี่ | มั | น | อ | ะ | ไ | ร = 7 cells, 10 code units
    const s = 'นี่มันอะไร';
    expect(s.length).toBe(10);
    expect(glyphCount(s)).toBe(7);
  });

  it('leaves Latin and Japanese counts alone', () => {
    expect(glyphCount('Hello!')).toBe(6);
    expect(glyphCount('なにこれ')).toBe(4);
  });

  it('is zero for an empty string', () => {
    expect(glyphCount('')).toBe(0);
  });
});

describe('fitFont', () => {
  const big = { x: 0, y: 0, w: 0.3, h: 0.2 };

  it('caps a short phrase in a big bubble at the ceiling', () => {
    expect(fitFont(big, 1.4, 'อะไร', 1).cqw).toBe(MAX_FONT_CQW);
  });

  it('never goes under the cqw floor however much text there is', () => {
    const tiny = { x: 0, y: 0, w: 0.02, h: 0.02 };
    expect(fitFont(tiny, 1.4, 'ก'.repeat(200), 1).cqw).toBe(MIN_FONT_CQW);
  });

  it('gives Thai with marks the same size as the same number of bare cells', () => {
    // Wide enough that no word is near the panel width, so only area decides.
    const box = { x: 0, y: 0, w: 0.3, h: 0.03 };
    const marked = fitFont(box, 1.4, 'ที่นี่ ที่นี่', 1).cqw; // 4 cells
    const bare = fitFont(box, 1.4, 'ทน ทน', 1).cqw; // 4 cells
    expect(marked).toBeCloseTo(bare, 6);
  });

  it('always carries a pixel floor, scaled with the reader setting', () => {
    expect(fitFont(big, 1.4, 'อะไร', 1).minPx).toBe(MIN_READABLE_PX);
    expect(fitFont(big, 1.4, 'อะไร', 1.5).minPx).toBe(MIN_READABLE_PX * 1.5);
  });

  it('scales the cqw size by the reader setting', () => {
    const box = { x: 0, y: 0, w: 0.3, h: 0.05 };
    const text = 'go go go go go go go go';
    const one = fitFont(box, 1.4, text, 1).cqw;
    expect(fitFont(box, 1.4, text, 2).cqw).toBeCloseTo(one * 2, 6);
  });

  it('sizes text so its longest word fits the panel width', () => {
    // The imhentai page that overlapped: 12 cells with no break in a 26.6% x
    // 24.4% panel got the 6cqw ceiling x1.2, 2.2x the panel's width.
    const panel = { x: 0.63, y: 0.14, w: 0.26558, h: 0.2441 };
    const text = 'x'.repeat(12);
    const f = fitFont(panel, 1.407, text, 1.2);
    expect(f.cqw * (12 * GLYPH_EM + 0.6)).toBeLessThanOrEqual(panel.w * 100);
  });

  it('lets a short phrase wrap between words instead of shrinking to one line', () => {
    // A narrow vertical-bubble panel: one line of all five words would need a
    // tiny size, two-cell words do not.
    const narrow = { x: 0, y: 0, w: 0.14, h: 0.25 };
    const text = 'ab cd ef gh ij';
    const oneLine = (14 * 0.95) / (14 * GLYPH_EM + 0.6);
    expect(fitFont(narrow, 1.4, text, 1).cqw).toBeGreaterThan(oneLine * 2);
  });

  it('keeps punctuation with the word it follows', () => {
    expect(longestWordGlyphs('wait!!!')).toBe(7);
    expect(longestWordGlyphs('go now')).toBe(3);
  });

  it('finds Thai word boundaries without spaces', () => {
    // ไป | ผจญภัย | ด้วยกัน | เถอะ — the longest is far shorter than the phrase.
    const phrase = 'ไปผจญภัยด้วยกันเถอะ';
    expect(longestWordGlyphs(phrase)).toBeLessThan(glyphCount(phrase));
  });

  it('does not push a phrase below the cqw floor in a sliver of a panel', () => {
    const sliver = { x: 0, y: 0, w: 0.01, h: 0.2 };
    expect(fitFont(sliver, 1.4, 'อะไรกัน', 1.5).cqw).toBeCloseTo(MIN_FONT_CQW * 1.5, 6);
  });

  it('survives broken inputs', () => {
    const f = fitFont({ x: 0, y: 0, w: -1, h: Number.NaN }, Number.NaN, '', Number.NaN);
    expect(f.cqw).toBe(MIN_FONT_CQW);
    expect(f.minPx).toBe(MIN_READABLE_PX);
  });
});

describe('plateFromCentre', () => {
  it('puts a plate that equals its panel at minus half its size', () => {
    const r = { x: 0.2, y: 0.1, w: 0.1, h: 0.2 };
    const p = plateFromCentre(r, r, 1.5);
    expect(p.dx).toBeCloseTo(-5, 6);
    expect(p.dy).toBeCloseTo(-15, 6);
    expect(p.w).toBeCloseTo(10, 6);
    expect(p.h).toBeCloseTo(30, 6);
  });

  it('keeps a narrow column centred inside a widened panel', () => {
    const rect = { x: 0.48, y: 0.1, w: 0.04, h: 0.3 };
    const panel = { x: 0.43, y: 0.1, w: 0.14, h: 0.3 };
    const p = plateFromCentre(rect, panel, 1);
    expect(p.dx + p.w / 2).toBeCloseTo(0, 6);
  });

  it('does not depend on panel size, only on its centre', () => {
    const rect = { x: 0.3, y: 0.3, w: 0.05, h: 0.1 };
    const a = plateFromCentre(rect, { x: 0.25, y: 0.25, w: 0.15, h: 0.2 }, 1.4);
    const b = plateFromCentre(rect, { x: 0.2, y: 0.2, w: 0.25, h: 0.3 }, 1.4);
    expect(a).toEqual(b);
  });
});
