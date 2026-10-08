import { describe, expect, it } from 'vitest';
import {
  clampOpacity,
  INK_MARGIN,
  inkRect,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  panelRect,
  plateAlphaOver,
  plateInPanel,
} from './panel-shape';

/** A page taller than it is wide, like every manga page in the fixtures. */
const ASPECT = 1280 / 1808 > 0 ? 1808 / 1280 : 1; // ≈1.41

describe('panelRect', () => {
  it('leaves a horizontal block alone', () => {
    // Thai runs along the axis the text already occupies, so the detected box
    // is already the right shape.
    const rect = { x: 0.1, y: 0.2, w: 0.4, h: 0.06 };
    expect(panelRect(rect, 'horizontal', ASPECT)).toEqual(rect);
  });

  it('widens a tall narrow column so horizontal text can fit', () => {
    // The reported bug: a 3%-wide column of vertical Japanese left Thai wrapping
    // after every character, one glyph per line down the page.
    const column = { x: 0.5, y: 0.1, w: 0.03, h: 0.25 };
    const panel = panelRect(column, 'vertical', ASPECT);

    expect(panel.w).toBeGreaterThan(column.w * 4);
    expect(panel.w).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
  });

  it('gives a column holding more text a wider panel', () => {
    // Width is bought with area, and a taller column holds more text. A fixed
    // width would starve long dialogue and overspend on a two-word aside.
    const short = panelRect({ x: 0.5, y: 0.1, w: 0.03, h: 0.1 }, 'vertical', ASPECT);
    const tall = panelRect({ x: 0.5, y: 0.1, w: 0.03, h: 0.45 }, 'vertical', ASPECT);

    expect(tall.w).toBeGreaterThan(short.w);
  });

  it('lifts a barely-there column to the floor', () => {
    // Two characters of vertical Japanese carry so little area that the widened
    // panel would still be a few glyphs per line without a floor.
    const tiny = { x: 0.5, y: 0.5, w: 0.02, h: 0.03 };
    expect(panelRect(tiny, 'vertical', ASPECT).w).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
  });

  it('keeps the height, so the original text stays covered', () => {
    // Shrinking height with the area would leave Japanese peeking out above and
    // below the Thai. The panel is the thing hiding it.
    const column = { x: 0.5, y: 0.1, w: 0.03, h: 0.25 };
    const panel = panelRect(column, 'vertical', ASPECT);

    expect(panel.y).toBe(column.y);
    expect(panel.h).toBe(column.h);
  });

  it('grows about the centre', () => {
    const column = { x: 0.5, y: 0.1, w: 0.04, h: 0.2 };
    const panel = panelRect(column, 'vertical', ASPECT);

    expect(panel.x + panel.w / 2).toBeCloseTo(column.x + column.w / 2, 6);
  });

  it('slides inside the image instead of hanging off the edge', () => {
    // Clipping would cut the words at that end; moving keeps all of them.
    const nearEdge = { x: 0.97, y: 0.1, w: 0.03, h: 0.3 };
    const panel = panelRect(nearEdge, 'vertical', ASPECT);

    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.w).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('never widens past the cap, however narrow the column', () => {
    const sliver = { x: 0.5, y: 0, w: 0.005, h: 1 };
    expect(panelRect(sliver, 'vertical', ASPECT).w).toBeLessThanOrEqual(MAX_PANEL_WIDTH);
  });

  it('only ever grows — a column already wide enough is left alone', () => {
    // Squeezing it to hit the target ratio would uncover the text it hides.
    const wide = { x: 0.1, y: 0.1, w: 0.5, h: 0.05 };
    const panel = panelRect(wide, 'vertical', ASPECT);

    expect(panel.w).toBeGreaterThanOrEqual(wide.w);
  });

  it('does not claim to reshape to a ratio — height is kept on purpose', () => {
    // Documenting the consequence so nobody "fixes" it later: the panel ends up
    // bigger than the block, not reshaped to 2.5:1. Shrinking height to hit a
    // ratio would uncover the Japanese the panel exists to hide.
    const column = { x: 0.4, y: 0.2, w: 0.02, h: 0.3 };
    const panel = panelRect(column, 'vertical', ASPECT);

    expect(panel.h).toBe(column.h);
    expect(panel.w * panel.h).toBeGreaterThan(column.w * column.h);
  });

  it('survives a degenerate rect or aspect rather than producing NaN', () => {
    const zero = { x: 0.5, y: 0.5, w: 0, h: 0 };
    expect(panelRect(zero, 'vertical', ASPECT)).toEqual(zero);

    const rect = { x: 0.1, y: 0.1, w: 0.05, h: 0.2 };
    expect(panelRect(rect, 'vertical', 0)).toEqual(rect);
    expect(panelRect(rect, 'vertical', Number.NaN)).toEqual(rect);
  });

  it('always contains the block it was grown from', () => {
    // The whole two-layer scheme rests on this: the cover plate is drawn inside
    // the panel, so if the panel could ever fail to contain the detected rect,
    // part of the original would be left uncovered and the compositing rule
    // below would be reasoning about the wrong region.
    const cases = [
      { x: 0.5, y: 0.1, w: 0.03, h: 0.25 },
      { x: 0.0, y: 0.0, w: 0.02, h: 0.4 },
      { x: 0.97, y: 0.1, w: 0.03, h: 0.3 },
      { x: 0.46, y: 0.2, w: 0.08, h: 0.02 },
      { x: 0.2, y: 0.5, w: 0.5, h: 0.3 },
    ];
    for (const rect of cases) {
      for (const aspect of [1, ASPECT, 0.4]) {
        const panel = panelRect(rect, 'vertical', aspect);
        expect(panel.x).toBeLessThanOrEqual(rect.x + 1e-9);
        expect(panel.x + panel.w).toBeGreaterThanOrEqual(rect.x + rect.w - 1e-9);
        expect(panel.y).toBeLessThanOrEqual(rect.y + 1e-9);
        expect(panel.y + panel.h).toBeGreaterThanOrEqual(rect.y + rect.h - 1e-9);
      }
    }
  });
});

/**
 * The plate is painted over the panel, so what the reader sees is the two
 * composited. `over` is that composite: the alpha the eye ends up with.
 */
const over = (plate: number, panel: number) => panel + plateAlphaOver(plate, panel) * (1 - panel);

describe('plateAlphaOver', () => {
  it('never lands darker than the darker of the two settings', () => {
    // The failure this exists to prevent: painting 0.92 over 0.92 gives 0.994,
    // an almost solid plate produced by two settings that each said 0.92.
    for (const plate of [0, 0.1, 0.5, 0.8, 0.92, 1]) {
      for (const panel of [0, 0.1, 0.5, 0.8, 0.92, 1]) {
        expect(over(plate, panel)).toBeCloseTo(Math.max(plate, panel), 9);
      }
    }
  });

  it('is not drawn at all when the panel is already at least as opaque', () => {
    // Which is also the coincident case — horizontal text, where the panel is
    // the same rectangle — so that never puts two elements on top of each other.
    expect(plateAlphaOver(0.5, 0.5)).toBe(0);
    expect(plateAlphaOver(0.3, 0.9)).toBe(0);
    expect(plateAlphaOver(0.9, 1)).toBe(0);
  });

  it('hides the original completely when asked to, whatever the panel is', () => {
    // The setting the split exists for: an opaque plate over a nearly clear
    // panel, so the art shows around the words but the Japanese does not.
    expect(plateAlphaOver(1, 0.05)).toBe(1);
    expect(over(1, 0.05)).toBeCloseTo(1, 9);
  });

  it('treats a broken value as opaque rather than as a hole', () => {
    // A settings record that has gone wrong should fail towards hiding the
    // source, not towards leaving untranslated Japanese showing through.
    expect(clampOpacity(Number.NaN)).toBe(1);
    expect(clampOpacity(undefined)).toBe(1);
    expect(clampOpacity(-3)).toBe(0);
    expect(clampOpacity(7)).toBe(1);
    expect(clampOpacity(0.4)).toBe(0.4);
  });
});

describe('plateInPanel', () => {
  it('fills the panel when the two coincide', () => {
    const rect = { x: 0.1, y: 0.2, w: 0.4, h: 0.06 };
    expect(plateInPanel(rect, rect)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('sits centred and full height inside a widened panel', () => {
    const column = { x: 0.5, y: 0.1, w: 0.03, h: 0.25 };
    const panel = panelRect(column, 'vertical', ASPECT);
    const plate = plateInPanel(column, panel);

    expect(plate.y).toBeCloseTo(0, 9);
    expect(plate.h).toBeCloseTo(1, 9);
    expect(plate.x + plate.w / 2).toBeCloseTo(0.5, 6);
    expect(plate.w).toBeLessThan(1);
  });

  it('stays inside the panel it is expressed against', () => {
    const nearEdge = { x: 0.97, y: 0.1, w: 0.03, h: 0.3 };
    const plate = plateInPanel(nearEdge, panelRect(nearEdge, 'vertical', ASPECT));

    expect(plate.x).toBeGreaterThanOrEqual(-1e-9);
    expect(plate.x + plate.w).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('does not divide by zero on a collapsed panel', () => {
    expect(plateInPanel({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});

describe('inkRect', () => {
  it('grows a block by the same physical margin across and down', () => {
    const aspect = 1.4;
    const r = inkRect({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, aspect);
    expect(r.x).toBeCloseTo(0.5 - INK_MARGIN, 9);
    expect(r.w).toBeCloseTo(0.1 + 2 * INK_MARGIN, 9);
    // Down is measured against height, which is `aspect` times longer.
    expect(r.y).toBeCloseTo(0.5 - INK_MARGIN / aspect, 9);
    expect(r.h).toBeCloseTo(0.1 + (2 * INK_MARGIN) / aspect, 9);
  });

  it('stays inside the image at the edges', () => {
    const r = inkRect({ x: 0, y: 0.995, w: 0.2, h: 0.005 }, 1.4);
    expect(r.x).toBe(0);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });

  it('survives a broken aspect', () => {
    const r = inkRect({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, Number.NaN);
    expect(Number.isFinite(r.y)).toBe(true);
  });
});
