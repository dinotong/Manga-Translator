import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PP_OCR_DEFAULTS } from '../offscreen/PpOcrDetector';
import { DEFAULT_SETTINGS } from '../shared/settings';
import {
  DETECT_POSTPROCESS,
  MEAN,
  STD,
  STRIDE,
  expandBox,
  planDetInput,
  rgbaToNchw,
  shrinkBox,
} from './preprocess';

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

describe('shrinkBox', () => {
  it('removes the dilation radius from every side', () => {
    expect(shrinkBox({ x: 100, y: 100, w: 60, h: 300 }, 14)).toEqual({
      x: 114,
      y: 114,
      w: 32,
      h: 272,
    });
  });

  it('restores a vertical column to its ink width', () => {
    // The reported symptom: at a 960px model input a 1.5% radius is 14px, so a
    // 30px column of vertical Japanese comes out of connected components at
    // 58px — nearly double — and the overlay panel is sized from it.
    const dilated = { x: 86, y: 86, w: 58, h: 428 };
    expect(shrinkBox(dilated, 14)).toEqual({ x: 100, y: 100, w: 30, h: 400 });
  });

  it('is the inverse of dilating a box by the same radius', () => {
    const ink = { x: 40, y: 80, w: 24, h: 200 };
    const grown = { x: ink.x - 9, y: ink.y - 9, w: ink.w + 18, h: ink.h + 18 };
    expect(shrinkBox(grown, 9)).toEqual(ink);
  });

  it('is a no-op at radius 0', () => {
    const box = { x: 5, y: 6, w: 7, h: 8 };
    expect(shrinkBox(box, 0)).toEqual(box);
  });

  it('collapses toward the centre instead of inverting', () => {
    // A blob thinner than twice the radius must not come back with negative
    // width — a rect the overlay cannot draw and grouping cannot reason about.
    const out = shrinkBox({ x: 100, y: 100, w: 10, h: 400 }, 50);
    expect(out.w).toBeGreaterThan(0);
    expect(out.h).toBeGreaterThan(0);
    expect(out.x).toBeGreaterThanOrEqual(100);
    expect(out.x + out.w).toBeLessThanOrEqual(110);
  });

  it('keeps the box centred on what it shrank from', () => {
    const before = { x: 100, y: 200, w: 80, h: 60 };
    const after = shrinkBox(before, 10);
    expect(after.x + after.w / 2).toBeCloseTo(before.x + before.w / 2, 6);
    expect(after.y + after.h / 2).toBeCloseTo(before.y + before.h / 2, 6);
  });
});

/**
 * The harness exists to predict the extension, and for a while it did not: its
 * form controls shipped dilate 0.015 and NMS 0.6 against the extension's 0.01
 * and off, and it applies those on every run. The owner's bug was diagnosed on
 * an instrument that was not calibrated to the thing it measured.
 *
 * So every place that turns a probability map into boxes now reads one
 * definition, and this is the guard that says so out loud. If a future change
 * wants different numbers, it changes DETECT_POSTPROCESS and everything follows.
 */
describe('DETECT_POSTPROCESS is the single definition', () => {
  it('is what the extension detector starts with', () => {
    expect(PP_OCR_DEFAULTS.dilateRatio).toBe(DETECT_POSTPROCESS.dilateRatio);
  });

  it('is what a fresh install stores', () => {
    expect(DEFAULT_SETTINGS.ocr.dilateRatio).toBe(DETECT_POSTPROCESS.dilateRatio);
  });

  it('offers a harness menu option for each value, since the UI selects by value', () => {
    // `els.dilate.value = String(...)` silently selects nothing when no option
    // matches, and the browser then shows the first one instead.
    const html = readFileSync(new URL('../../../spike/index.html', import.meta.url), 'utf8');
    for (const v of [DETECT_POSTPROCESS.dilateRatio, DETECT_POSTPROCESS.nmsIou]) {
      expect(html, `no <option value="${v}">`).toContain(`value="${v}"`);
    }
  });

  it('leaves the harness menus with no hardcoded default to drift', () => {
    const html = readFileSync(new URL('../../../spike/index.html', import.meta.url), 'utf8');
    const menus = html.match(/<select id="(?:dilate|nms)">[\s\S]*?<\/select>/g) ?? [];
    expect(menus).toHaveLength(2);
    for (const menu of menus) expect(menu).not.toContain('selected');
  });
});
