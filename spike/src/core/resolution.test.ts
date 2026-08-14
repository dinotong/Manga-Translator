import { describe, expect, it } from 'vitest';
import { PRESETS, fitLongEdge, planResolution, resolutionWarning } from './resolution';

describe('fitLongEdge', () => {
  it('downscales a large page and keeps its aspect ratio', () => {
    // MangaDex: 3496x4960 -> long edge 1600.
    const out = fitLongEdge({ w: 3496, h: 4960 }, 1600);
    expect(out.h).toBe(1600);
    expect(out.w / out.h).toBeCloseTo(3496 / 4960, 3);
  });

  it('never upscales a small page', () => {
    // imhentai: 1280x1808 with a 2048 target must stay 1280x1808.
    // Enlarging costs ~1.5x the OCR time and adds no detail.
    expect(fitLongEdge({ w: 1280, h: 1808 }, 2048)).toEqual({ w: 1280, h: 1808 });
  });

  it('leaves a page already at the target untouched', () => {
    expect(fitLongEdge({ w: 1131, h: 1600 }, 1600)).toEqual({ w: 1131, h: 1600 });
  });

  it('handles landscape spreads', () => {
    const out = fitLongEdge({ w: 4000, h: 1400 }, 1600);
    expect(out.w).toBe(1600);
    expect(out.h).toBe(560);
  });

  it('never rounds a dimension down to zero', () => {
    const out = fitLongEdge({ w: 4000, h: 3 }, 100);
    expect(out.h).toBeGreaterThanOrEqual(1);
  });

  it('does not crash on a zero-size source', () => {
    expect(fitLongEdge({ w: 0, h: 0 }, 1600)).toEqual({ w: 0, h: 0 });
  });
});

describe('planResolution', () => {
  it('gives recognition a larger bitmap than detection when the source allows', () => {
    const plan = planResolution({ w: 3496, h: 4960 }, PRESETS.balanced);
    expect(plan.rec.h).toBeGreaterThan(plan.det.h);
  });

  it('caps recognition at the source while detection still downscales', () => {
    // imhentai: 1280x1808. The LONG edge is 1808, so the 1600 detection target
    // still shrinks it, while the 2048 recognition target is above the source
    // and clamps to native. Crops therefore come from full-resolution pixels
    // even though detection ran on a smaller bitmap — which is the point.
    const plan = planResolution({ w: 1280, h: 1808 }, PRESETS.balanced);

    expect(plan.det).toEqual({ w: 1133, h: 1600 });
    expect(plan.rec).toEqual({ w: 1280, h: 1808 });
  });

  it('collapses both to the source when even detection cannot downscale', () => {
    // Shonen Jump+ canvas: smaller than every target, so nothing is resized.
    const plan = planResolution({ w: 371, h: 586 }, PRESETS.balanced);

    expect(plan.det).toEqual(plan.rec);
    expect(plan.det).toEqual({ w: 371, h: 586 });
  });
});

describe('resolutionWarning', () => {
  it('stays quiet at a comfortable page size', () => {
    expect(resolutionWarning({ w: 1131, h: 1600 })).toBeNull();
  });

  it('warns on a Giga Viewer canvas', () => {
    // Shonen Jump+ renders at 371x586; glyphs land around 10px.
    const warning = resolutionWarning({ w: 371, h: 586 });
    expect(warning).toContain('Zoom');
  });

  it('stops warning once the reader zooms in', () => {
    expect(resolutionWarning({ w: 742, h: 1172 })).toBeNull();
  });
});
