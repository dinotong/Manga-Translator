import { describe, expect, it } from 'vitest';
import { MEAN, STD, STRIDE, expandBox, planDetInput, rgbaToNchw } from './preprocess';

describe('planDetInput', () => {
  it('produces sides that are multiples of the stride', () => {
    const { input } = planDetInput({ w: 1131, h: 1600 });
    expect(input.w % STRIDE).toBe(0);
    expect(input.h % STRIDE).toBe(0);
  });

  it('caps the long side at maxSide', () => {
    const { input } = planDetInput({ w: 1131, h: 1600 }, 960);
    expect(Math.max(input.w, input.h)).toBeLessThanOrEqual(960 + STRIDE);
  });

  it('does not enlarge a source already under the cap', () => {
    const { input } = planDetInput({ w: 371, h: 586 }, 960);
    expect(input.w).toBeLessThanOrEqual(384);
    expect(input.h).toBeLessThanOrEqual(608);
  });

  it('maps model coordinates back onto the source', () => {
    const source = { w: 1280, h: 1820 };
    const { input, scaleBack } = planDetInput(source, 960);

    // A box spanning the full model input must span the full source.
    expect(input.w * scaleBack.x).toBeCloseTo(source.w, 6);
    expect(input.h * scaleBack.y).toBeCloseTo(source.h, 6);
  });

  it('keeps the aspect ratio close despite stride rounding', () => {
    const source = { w: 1280, h: 1820 };
    const { input } = planDetInput(source, 960);
    expect(input.w / input.h).toBeCloseTo(source.w / source.h, 1);
  });

  it('survives a zero-size source', () => {
    expect(() => planDetInput({ w: 0, h: 0 })).not.toThrow();
  });
});

describe('rgbaToNchw', () => {
  it('lays channels out planar, not interleaved', () => {
    // One red pixel, one green pixel.
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const out = rgbaToNchw(rgba, { w: 2, h: 1 });

    expect(out.length).toBe(6);
    // R plane [0..1], G plane [2..3], B plane [4..5].
    expect(out[0]).toBeGreaterThan(out[1]!); // pixel 0 is redder than pixel 1
    expect(out[3]).toBeGreaterThan(out[2]!); // pixel 1 is greener than pixel 0
  });

  it('normalizes with the ImageNet statistics', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255]);
    const out = rgbaToNchw(rgba, { w: 1, h: 1 });

    expect(out[0]).toBeCloseTo((1 - MEAN[0]) / STD[0], 5);
    expect(out[1]).toBeCloseTo((1 - MEAN[1]) / STD[1], 5);
    expect(out[2]).toBeCloseTo((1 - MEAN[2]) / STD[2], 5);
  });

  it('makes black negative on every channel', () => {
    const out = rgbaToNchw(new Uint8ClampedArray([0, 0, 0, 255]), { w: 1, h: 1 });
    expect([...out].every((v) => v < 0)).toBe(true);
  });

  it('ignores the alpha channel', () => {
    const opaque = rgbaToNchw(new Uint8ClampedArray([120, 120, 120, 255]), { w: 1, h: 1 });
    const clear = rgbaToNchw(new Uint8ClampedArray([120, 120, 120, 0]), { w: 1, h: 1 });
    expect([...opaque]).toEqual([...clear]);
  });
});

describe('expandBox', () => {
  it('grows by a fraction of the short side', () => {
    // Short side 100, ratio 0.1 -> 10px each way.
    const out = expandBox({ x: 200, y: 200, w: 100, h: 400 }, 0.1, { w: 2000, h: 2000 });
    expect(out).toEqual({ x: 190, y: 190, w: 120, h: 420 });
  });

  it('clips at the bitmap edge', () => {
    const out = expandBox({ x: 0, y: 0, w: 100, h: 100 }, 0.5, { w: 120, h: 120 });
    expect(out.x).toBe(0);
    expect(out.x + out.w).toBeLessThanOrEqual(120);
    expect(out.y + out.h).toBeLessThanOrEqual(120);
  });

  it('is a no-op at ratio 0', () => {
    const box = { x: 10, y: 20, w: 30, h: 40 };
    expect(expandBox(box, 0, { w: 1000, h: 1000 })).toEqual(box);
  });

  it('keeps two nearby columns from touching at the default ratio', () => {
    // Adjacent columns of vertical text, 12px apart, glyph width 30.
    // Merging them is grouping's call, so detection must leave a gap.
    const bounds = { w: 1000, h: 1000 };
    const a = expandBox({ x: 100, y: 0, w: 30, h: 300 }, 0.1, bounds);
    const b = expandBox({ x: 142, y: 0, w: 30, h: 300 }, 0.1, bounds);
    expect(a.x + a.w).toBeLessThan(b.x);
  });
});
