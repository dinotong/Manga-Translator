import { describe, expect, it } from 'vitest';
import { placePanels, type PanelPlacement } from './panel-layout';
import { panelRect } from './panel-shape';
import { planMerges } from './merge-proposals';
import { PAGES, type FixturePage } from './pages.fixture';
import type { NormRect } from '../types';

/**
 * What ordinary pages do under the two new rules.
 *
 * The requirement these exist for is stated as a negative — *ordinary pages must
 * not change* — and a negative is exactly the claim that is easiest to assert
 * and hardest to have earned. So the numbers below are golden: every page's
 * outcome is written down, including the ones where something did move, and a
 * future tweak that changes an ordinary page fails here rather than being
 * discovered on a chapter.
 *
 * These are hand-built layouts, not detector output — see pages.fixture.ts for
 * why, and for what that does and does not buy.
 */

const aspectOf = (p: FixturePage) => p.natural.h / p.natural.w;

function placements(page: FixturePage): PanelPlacement[] {
  const aspect = aspectOf(page);
  return page.blocks.map((b) => ({
    anchor: b.rect,
    panel: panelRect(b.rect, b.direction, aspect),
  }));
}

function overlapArea(a: NormRect, b: NormRect, aspect: number): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 1e-6 && h > 1e-6 ? w * h * aspect : 0;
}

function worstOverlap(rects: readonly NormRect[], aspect: number): number {
  let worst = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      worst = Math.max(worst, overlapArea(rects[i]!, rects[j]!, aspect));
    }
  }
  return worst;
}

describe('ordinary pages · panel layout', () => {
  it.each(PAGES)('$name — no two panels share a pixel', (page) => {
    const placed = placePanels(placements(page), aspectOf(page));
    expect(worstOverlap(placed.map((p) => p.rect), aspectOf(page))).toBe(0);
  });

  it.each(PAGES)('$name — every panel still covers its own ink', (page) => {
    const items = placements(page);
    placePanels(items, aspectOf(page)).forEach((p, i) => {
      const a = items[i]!.anchor;
      expect(p.rect.x).toBeLessThanOrEqual(a.x + 1e-6);
      expect(p.rect.y).toBeLessThanOrEqual(a.y + 1e-6);
      expect(p.rect.x + p.rect.w).toBeGreaterThanOrEqual(a.x + a.w - 1e-6);
      expect(p.rect.y + p.rect.h).toBeGreaterThanOrEqual(a.y + a.h - 1e-6);
    });
  });

  /**
   * The golden table. `moved` counts panels the de-overlap step touched at all;
   * `trimmed` counts the ones that had to give width back.
   *
   * Read it as the honest answer to "does this change ordinary pages?" — and the
   * answer is no, on all four of them, including the dense thirteen-bubble page.
   * Bubbles on a printed page sit far enough apart that the widened panels never
   * meet. The only fixture that moves at all is the afterword, where every
   * column is one glyph wide and a few percent from the next, which is precisely
   * the page that was broken.
   */
  const EXPECTED: Record<string, { moved: number; trimmed: number; crowded: number }> = {
    'mangadex-quiet': { moved: 0, trimmed: 0, crowded: 0 },
    'mangadex-dense-13': { moved: 0, trimmed: 0, crowded: 0 },
    'imhentai-two': { moved: 0, trimmed: 0, crowded: 0 },
    'latin-horizontal': { moved: 0, trimmed: 0, crowded: 0 },
    'afterword-handwritten': { moved: 6, trimmed: 2, crowded: 0 },
  };

  it.each(PAGES)('$name — moves exactly what the golden table says', (page) => {
    const items = placements(page);
    const placed = placePanels(items, aspectOf(page));

    const moved = placed.filter((p, i) => {
      const w = items[i]!.panel;
      return (
        Math.abs(p.rect.x - w.x) > 1e-6 ||
        Math.abs(p.rect.y - w.y) > 1e-6 ||
        Math.abs(p.rect.w - w.w) > 1e-6 ||
        Math.abs(p.rect.h - w.h) > 1e-6
      );
    }).length;

    expect({
      moved,
      trimmed: placed.filter((p) => p.trimmed).length,
      crowded: placed.filter((p) => p.crowded).length,
    }).toEqual(EXPECTED[page.name]);
  });

  it.each(PAGES)('$name — is never worse than drawing the panels as asked', (page) => {
    const items = placements(page);
    const aspect = aspectOf(page);
    const before = worstOverlap(items.map((i) => i.panel), aspect);
    const after = worstOverlap(placePanels(items, aspect).map((p) => p.rect), aspect);
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe('ordinary pages · model grouping', () => {
  it.each(PAGES)('$name — proposing nothing changes nothing', (page) => {
    const plan = planMerges(page.blocks, [], aspectOf(page));
    expect(plan).toEqual({ accepted: [], rejected: [] });
  });

  /**
   * The regression that matters most. Every adjacent pair of bubbles on every
   * ordinary page is offered to the veto as if the model had claimed it was one
   * sentence. None may be accepted — a merged pair of speakers is one confident
   * wrong translation across two bubbles, and the reader cannot see it happen.
   */
  it.each(PAGES.filter((p) => !p.name.startsWith('afterword')))(
    '$name — refuses every pair of neighbouring bubbles',
    (page) => {
      for (let i = 0; i < page.blocks.length; i++) {
        for (let j = i + 1; j < page.blocks.length; j++) {
          const plan = planMerges(page.blocks, [{ members: [i, j] }], aspectOf(page));
          expect(plan.accepted, `${page.name} ${i}+${j}`).toEqual([]);
        }
      }
    },
  );

  it('accepts the afterword run the automatic thresholds refused', () => {
    const page = PAGES.find((p) => p.name === 'afterword-handwritten')!;
    const plan = planMerges(page.blocks, [{ members: [0, 1, 2, 3] }], aspectOf(page));

    expect(plan.rejected).toEqual([]);
    expect(plan.accepted[0]!.members).toEqual([0, 1, 2, 3]);
  });

  it('will not stretch that run to reach the separate note below it', () => {
    const page = PAGES.find((p) => p.name === 'afterword-handwritten')!;
    const plan = planMerges(page.blocks, [{ members: [0, 1, 2, 3, 4, 5] }], aspectOf(page));
    expect(plan.accepted).toEqual([]);
  });

  /**
   * Merging is what makes the afterword readable, and the reason is geometric:
   * four one-glyph columns become one panel wide enough to set Thai across,
   * instead of four panels fighting for the same band of page.
   */
  it('turns the afterword run into one panel wider than any of its parts', () => {
    const page = PAGES.find((p) => p.name === 'afterword-handwritten')!;
    const aspect = aspectOf(page);
    const merged = planMerges(page.blocks, [{ members: [0, 1, 2, 3] }], aspect).accepted[0]!;

    const before = placePanels(placements(page), aspect);
    const widestFragment = Math.max(...[0, 1, 2, 3].map((i) => before[i]!.rect.w));

    const after = placePanels(
      [
        { anchor: merged.rect, panel: panelRect(merged.rect, 'vertical', aspect) },
        ...[4, 5].map((i) => ({
          anchor: page.blocks[i]!.rect,
          panel: panelRect(page.blocks[i]!.rect, 'vertical', aspect),
        })),
      ],
      aspect,
    );

    expect(after[0]!.rect.w).toBeGreaterThan(widestFragment);
    expect(worstOverlap(after.map((p) => p.rect), aspect)).toBe(0);
  });
});
