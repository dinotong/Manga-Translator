import { describe, expect, it } from 'vitest';
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, panelRect } from './panel-shape';

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
});
