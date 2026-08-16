import { describe, expect, it } from 'vitest';
import { panelRect } from './panel-shape';
import { placePanels, type PanelPlacement, type PlacedPanel } from './panel-layout';
import type { NormRect } from '../types';

/** MangaDex's real page shape, 3496x4960. */
const ASPECT = 4960 / 3496;

/** Overlap of two normalized rects, in the aspect-corrected space. */
function overlap(a: NormRect, b: NormRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 1e-6 && h > 1e-6 ? w * h * ASPECT : 0;
}

function worstPair(placed: readonly PlacedPanel[]): number {
  let worst = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      worst = Math.max(worst, overlap(placed[i]!.rect, placed[j]!.rect));
    }
  }
  return worst;
}

function covers(outer: NormRect, inner: NormRect): boolean {
  const e = 1e-6;
  return (
    outer.x <= inner.x + e &&
    outer.y <= inner.y + e &&
    outer.x + outer.w >= inner.x + inner.w - e &&
    outer.y + outer.h >= inner.y + inner.h - e
  );
}

/** A vertical column and the panel `panelRect` would widen it into. */
function column(x: number, y: number, w = 0.03, h = 0.3): PanelPlacement {
  const anchor = { x, y, w, h };
  return { anchor, panel: panelRect(anchor, 'vertical', ASPECT) };
}

describe('placePanels', () => {
  it('returns nothing for nothing', () => {
    expect(placePanels([], ASPECT)).toEqual([]);
  });

  it('leaves a lone panel exactly as asked', () => {
    const only = column(0.4, 0.2);
    const [placed] = placePanels([only], ASPECT);
    expect(placed?.rect).toEqual(only.panel);
    expect(placed?.trimmed).toBe(false);
    expect(placed?.crowded).toBe(false);
  });

  it('leaves panels that already fit alone', () => {
    const items = [column(0.05, 0.05), column(0.75, 0.55)];
    const placed = placePanels(items, ASPECT);
    expect(placed.map((p) => p.rect)).toEqual(items.map((i) => i.panel));
    expect(placed.every((p) => !p.trimmed && !p.crowded)).toBe(true);
  });

  /**
   * The case this exists for, and the one it must solve without giving anything
   * up: two neighbouring columns, each widened past the other, with empty page
   * on both sides. Sliding costs nothing, so both keep every pixel of the width
   * `panelRect` bought them.
   */
  it('slides two colliding columns apart instead of shrinking them', () => {
    const items = [column(0.3, 0.1), column(0.36, 0.1)];
    const placed = placePanels(items, ASPECT);

    expect(worstPair(placed)).toBe(0);
    expect(placed[0]!.rect.w).toBeCloseTo(items[0]!.panel.w, 10);
    expect(placed[1]!.rect.w).toBeCloseTo(items[1]!.panel.w, 10);
    expect(placed.every((p) => !p.trimmed)).toBe(true);
  });

  it('never lets a panel stop covering its own ink', () => {
    const items = [column(0.3, 0.1), column(0.36, 0.1), column(0.42, 0.12), column(0.48, 0.05)];
    placePanels(items, ASPECT).forEach((p, i) => {
      expect(covers(p.rect, items[i]!.anchor)).toBe(true);
    });
  });

  it('never grows a panel past what it asked for', () => {
    const items = [column(0.3, 0.1), column(0.36, 0.1), column(0.42, 0.12)];
    placePanels(items, ASPECT).forEach((p, i) => {
      expect(p.rect.w).toBeLessThanOrEqual(items[i]!.panel.w + 1e-9);
      expect(p.rect.h).toBeLessThanOrEqual(items[i]!.panel.h + 1e-9);
    });
  });

  /**
   * Five columns whose widened panels all want the same band. There is not
   * enough page for five full-width panels, so some must give width back — but
   * none of them may end up sharing pixels with another.
   */
  it('trims when there is no room left to slide into', () => {
    const items = [0.1, 0.16, 0.22, 0.28, 0.34].map((x) => column(x, 0.2));
    const placed = placePanels(items, ASPECT);

    expect(worstPair(placed)).toBe(0);
    expect(placed.some((p) => p.trimmed)).toBe(true);
    placed.forEach((p, i) => expect(covers(p.rect, items[i]!.anchor)).toBe(true));
  });

  it('resolves a whole crowded page without any pair overlapping', () => {
    // A grid of disjoint columns, close enough that every widened panel collides
    // with several neighbours.
    const items: PanelPlacement[] = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 6; col++) {
        items.push(column(0.05 + col * 0.05, 0.05 + row * 0.24, 0.025, 0.2));
      }
    }
    const placed = placePanels(items, ASPECT);

    expect(placed).toHaveLength(24);
    expect(worstPair(placed)).toBe(0);
    expect(placed.every((p) => !p.crowded)).toBe(true);
    placed.forEach((p, i) => expect(covers(p.rect, items[i]!.anchor)).toBe(true));
  });

  /**
   * The guarantee, stated as a test: disjoint ink in, disjoint panels out. If
   * this ever fails, the fallback-to-anchor path is broken, because the anchors
   * are always a legal answer.
   */
  it('is disjoint whenever the detected boxes are disjoint', () => {
    // Deterministic pseudo-random widths and heights on a disjoint grid.
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

    const items: PanelPlacement[] = [];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const w = 0.01 + rand() * 0.05;
        const h = 0.02 + rand() * 0.12;
        items.push(column(0.02 + col * 0.19, 0.02 + row * 0.19, w, h));
      }
    }
    // The grid cells are 0.19 apart and nothing is wider than 0.06, so the
    // anchors really are disjoint; the premise of the guarantee holds.
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        expect(overlap(items[i]!.anchor, items[j]!.anchor)).toBe(0);
      }
    }

    const placed = placePanels(items, ASPECT);
    expect(worstPair(placed)).toBe(0);
  });

  /**
   * The only case geometry cannot fix. Two detected boxes that already overlap
   * cannot both be covered by disjoint rectangles, so the panels collapse to the
   * ink itself — the smallest overlap available — and say so rather than
   * pretending.
   */
  it('collapses to the ink and flags it when the detected boxes themselves overlap', () => {
    const a: NormRect = { x: 0.3, y: 0.1, w: 0.12, h: 0.3 };
    const b: NormRect = { x: 0.36, y: 0.2, w: 0.12, h: 0.3 };
    const items: PanelPlacement[] = [
      { anchor: a, panel: panelRect(a, 'vertical', ASPECT) },
      { anchor: b, panel: panelRect(b, 'vertical', ASPECT) },
    ];

    const placed = placePanels(items, ASPECT);
    expect(placed[0]!.rect).toEqual(a);
    expect(placed[1]!.rect).toEqual(b);
    expect(placed.every((p) => p.crowded)).toBe(true);
    // Never worse than doing nothing at all, which is what shipped before.
    expect(worstPair(placed)).toBeLessThanOrEqual(overlap(items[0]!.panel, items[1]!.panel));
  });

  it('gives the earlier block in reading order the better placement', () => {
    const items = [column(0.3, 0.1), column(0.36, 0.1)];
    const forwards = placePanels(items, ASPECT);
    const backwards = placePanels([...items].reverse(), ASPECT);
    // Both orders resolve, and the answer depends on the order — which is why
    // callers must pass reading order.
    expect(worstPair(forwards)).toBe(0);
    expect(worstPair(backwards)).toBe(0);
    expect(forwards[0]!.rect).not.toEqual(backwards[1]!.rect);
  });

  it('is deterministic', () => {
    const items = [column(0.3, 0.1), column(0.36, 0.1), column(0.42, 0.12)];
    expect(placePanels(items, ASPECT)).toEqual(placePanels(items, ASPECT));
  });

  it('survives a broken aspect rather than producing NaN', () => {
    const items = [column(0.3, 0.1), column(0.36, 0.1)];
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const placed = placePanels(items, aspect);
      expect(placed).toHaveLength(2);
      for (const p of placed) {
        expect(Number.isFinite(p.rect.x)).toBe(true);
        expect(Number.isFinite(p.rect.y)).toBe(true);
        expect(Number.isFinite(p.rect.w)).toBe(true);
        expect(Number.isFinite(p.rect.h)).toBe(true);
      }
    }
  });

  it('keeps every panel inside the image', () => {
    const items = [column(0.02, 0.02), column(0.08, 0.02), column(0.93, 0.7), column(0.88, 0.7)];
    for (const p of placePanels(items, ASPECT)) {
      expect(p.rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.rect.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('leaves horizontal panels alone, since they were never widened', () => {
    // panelRect returns horizontal blocks unchanged, so panel === anchor and
    // there is nothing to give back.
    const a: NormRect = { x: 0.1, y: 0.1, w: 0.3, h: 0.05 };
    const b: NormRect = { x: 0.5, y: 0.1, w: 0.3, h: 0.05 };
    const items: PanelPlacement[] = [
      { anchor: a, panel: panelRect(a, 'horizontal', ASPECT) },
      { anchor: b, panel: panelRect(b, 'horizontal', ASPECT) },
    ];
    expect(placePanels(items, ASPECT).map((p) => p.rect)).toEqual([a, b]);
  });
});
