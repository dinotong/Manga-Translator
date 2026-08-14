import { describe, expect, it } from 'vitest';
import {
  computeContentBox,
  gap1d,
  iou,
  overlapRatio,
  padRect,
  toNorm,
  toPix,
  unionAll,
} from './geometry';

describe('overlapRatio', () => {
  it('is 1 when the shorter interval sits entirely inside the longer', () => {
    // A one-character retort beside a long column still belongs to it.
    expect(overlapRatio(0, 100, 40, 10)).toBe(1);
  });

  it('measures against the shorter interval, not the union', () => {
    expect(overlapRatio(0, 100, 50, 100)).toBeCloseTo(0.5);
  });

  it('is 0 for disjoint intervals', () => {
    expect(overlapRatio(0, 10, 20, 10)).toBe(0);
  });
});

describe('gap1d', () => {
  it('is 0 when intervals touch or overlap', () => {
    expect(gap1d(0, 10, 10, 10)).toBe(0);
    expect(gap1d(0, 10, 5, 10)).toBe(0);
  });

  it('measures the empty space between them', () => {
    expect(gap1d(0, 10, 25, 10)).toBe(15);
  });

  it('is symmetric', () => {
    expect(gap1d(25, 10, 0, 10)).toBe(gap1d(0, 10, 25, 10));
  });
});

describe('iou', () => {
  it('is 1 for identical rects', () => {
    const r = { x: 5, y: 5, w: 10, h: 10 };
    expect(iou(r, r)).toBe(1);
  });

  it('is 0 for disjoint rects', () => {
    expect(iou({ x: 0, y: 0, w: 5, h: 5 }, { x: 100, y: 100, w: 5, h: 5 })).toBe(0);
  });

  it('flags near-duplicates across a webtoon slice seam', () => {
    // Same bubble seen from two overlapping slices, off by a few pixels.
    const a = { x: 100, y: 200, w: 80, h: 120 };
    const b = { x: 103, y: 204, w: 80, h: 120 };
    expect(iou(a, b)).toBeGreaterThan(0.6);
  });
});

describe('unionAll', () => {
  it('wraps every input rect', () => {
    expect(
      unionAll([
        { x: 10, y: 10, w: 10, h: 10 },
        { x: 30, y: 5, w: 10, h: 40 },
      ]),
    ).toEqual({ x: 10, y: 5, w: 30, h: 40 });
  });

  it('throws on empty input rather than returning a bogus zero rect', () => {
    expect(() => unionAll([])).toThrow();
  });
});

describe('padRect', () => {
  it('grows by a fraction of the rect size', () => {
    const p = padRect({ x: 100, y: 100, w: 100, h: 200 }, 0.1, { w: 1000, h: 1000 });
    expect(p).toEqual({ x: 90, y: 80, w: 120, h: 240 });
  });

  it('clips at the bitmap edge instead of going negative', () => {
    const p = padRect({ x: 0, y: 0, w: 50, h: 50 }, 0.5, { w: 60, h: 60 });
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
    expect(p.x + p.w).toBeLessThanOrEqual(60);
    expect(p.y + p.h).toBeLessThanOrEqual(60);
  });
});

describe('toNorm / toPix', () => {
  it('round-trips through a different target size', () => {
    const natural = { w: 3496, h: 4960 };
    const rect = { x: 1000, y: 2000, w: 400, h: 800 };
    const back = toPix(toNorm(rect, natural), natural);

    expect(back.x).toBeCloseTo(rect.x, 6);
    expect(back.w).toBeCloseTo(rect.w, 6);
  });

  it('scales cached coordinates onto a smaller rendered box', () => {
    // The reason coordinates are stored normalized: same cache entry, any size.
    const norm = toNorm({ x: 1748, y: 2480, w: 350, h: 496 }, { w: 3496, h: 4960 });
    const rendered = toPix(norm, { w: 507, h: 720 });

    expect(rendered.x).toBeCloseTo(253.5, 1);
    expect(rendered.y).toBeCloseTo(360, 1);
  });

  it('clamps out-of-bounds detector output', () => {
    const n = toNorm({ x: -10, y: 0, w: 99999, h: 10 }, { w: 100, h: 100 });
    expect(n.x).toBe(0);
    expect(n.w).toBe(1);
  });
});

describe('computeContentBox', () => {
  it('letterboxes with object-fit: contain', () => {
    // MangaDex: a 3496x4960 page inside a 507x720 box. The page is very slightly
    // wider in aspect than the box, so width is the limiting axis and the bars
    // are horizontal — a fraction of a pixel top and bottom.
    const box = computeContentBox({ w: 507, h: 720 }, { w: 3496, h: 4960 }, 'contain');

    expect(box.w).toBeCloseTo(507, 5);
    expect(box.h).toBeLessThanOrEqual(720);
    expect(box.w / box.h).toBeCloseTo(3496 / 4960, 6);
    // Bars are split evenly, so content stays centred on both axes.
    expect(box.x * 2 + box.w).toBeCloseTo(507, 5);
    expect(box.y * 2 + box.h).toBeCloseTo(720, 5);
  });

  it('letterboxes on the other axis when the box is the wrong shape', () => {
    // A portrait page in a landscape window: pillarboxed, x > 0.
    const box = computeContentBox({ w: 1200, h: 700 }, { w: 1280, h: 1808 }, 'contain');

    expect(box.h).toBeCloseTo(700, 5);
    expect(box.x).toBeGreaterThan(0);
    expect(box.y).toBeCloseTo(0, 5);
  });

  it('fills the element with object-fit: fill', () => {
    expect(computeContentBox({ w: 300, h: 100 }, { w: 10, h: 10 }, 'fill')).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 100,
    });
  });

  it('overflows the element with object-fit: cover', () => {
    const box = computeContentBox({ w: 100, h: 100 }, { w: 200, h: 100 }, 'cover');
    expect(box.w).toBeGreaterThanOrEqual(100);
    expect(box.x).toBeLessThanOrEqual(0);
  });

  it('does not divide by zero on an undecoded image', () => {
    expect(() => computeContentBox({ w: 100, h: 100 }, { w: 0, h: 0 })).not.toThrow();
  });
});
