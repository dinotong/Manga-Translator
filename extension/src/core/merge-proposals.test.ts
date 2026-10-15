import { describe, expect, it } from 'vitest';
import {
  MERGE_LIMITS,
  type MergeableBlock,
  planMerges,
  type MergeProposal,
} from './merge-proposals';

/** MangaDex's real page shape, 3496x4960. */
const ASPECT = 4960 / 3496;

/** A ~70px glyph on a 3496px-wide page, in the image-width units this module uses. */
const GLYPH = 0.02;

function column(x: number, y: number, h: number, glyph = GLYPH): MergeableBlock {
  return { rect: { x, y, w: glyph * 1.1, h }, direction: 'vertical', glyph };
}

/** A whole speech bubble: several columns already grouped into one block. */
function bubble(x: number, y: number, columns: number, h: number): MergeableBlock {
  return {
    rect: { x, y, w: GLYPH * 2 * columns, h },
    direction: 'vertical',
    glyph: GLYPH,
  };
}

const p = (...members: number[]): MergeProposal => ({ members });

describe('planMerges', () => {
  /**
   * The page that started this. Freeform vertical handwriting, three columns of
   * different lengths starting at different heights, one sentence between them.
   * Automatic grouping refuses because the columns barely overlap along the
   * reading axis; the model has read them and says they are one text.
   */
  it('accepts staggered handwritten columns the thresholds refused', () => {
    const blocks = [column(0.6, 0.1, 0.3), column(0.555, 0.14, 0.22), column(0.51, 0.09, 0.35)];
    const plan = planMerges(blocks, [p(0, 1, 2)], ASPECT);

    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]!.members).toEqual([0, 1, 2]);
    const { x, y, w, h } = plan.accepted[0]!.rect;
    expect([x, y, w, h].map((v) => +v.toFixed(6))).toEqual([0.51, 0.09, 0.112, 0.35]);
  });

  it('accepts columns with no overlap at all along the reading axis', () => {
    // One below the other and to the side — a diagonal pair, which the automatic
    // rule rejects outright and which handwriting produces constantly.
    const blocks = [column(0.6, 0.1, 0.12), column(0.56, 0.26, 0.14)];
    expect(planMerges(blocks, [p(0, 1)], ASPECT).accepted).toHaveLength(1);
  });

  /**
   * The regression that must never happen. Two characters speaking in
   * neighbouring bubbles: merged, the reader gets one confident wrong
   * translation covering both, and no way to tell.
   */
  it('refuses to merge two whole speech bubbles', () => {
    const blocks = [bubble(0.55, 0.1, 3, 0.25), bubble(0.3, 0.12, 3, 0.25)];
    const plan = planMerges(blocks, [p(0, 1)], ASPECT);

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]!.reason).toBe('not-a-fragment');
  });

  it('refuses even when the two bubbles are touching', () => {
    const blocks = [bubble(0.5, 0.1, 3, 0.25), bubble(0.38, 0.1, 3, 0.25)];
    expect(planMerges(blocks, [p(0, 1)], ASPECT).rejected[0]!.reason).toBe('not-a-fragment');
  });

  /**
   * D-037, the failure that took this from "on by default" to "opt-in and
   * vertical only". Three English balloons abreast in one panel, two lines of
   * lettering each, ordinary spacing — merged, and one balloon's translation
   * drawn across all three.
   *
   * Every other check passed on that page and none of them could have caught
   * it: "at most 2.5 glyphs across the reading axis" counts columns on vertical
   * text and *lines* on horizontal text, and two lines is a whole balloon. See
   * spike/src/core/pages.fixture.ts for the page these numbers come from.
   */
  it('refuses a row of English balloons, whatever the rest of the geometry says', () => {
    const line = (x: number, y: number, w: number): MergeableBlock => ({
      rect: { x, y, w, h: 72 / 2400 },
      direction: 'horizontal',
      glyph: 30 / 1600,
    });
    const blocks = [
      line(150 / 1600, 210 / 2400, 150 / 1600),
      line(400 / 1600, 250 / 2400, 190 / 1600),
      line(690 / 1600, 215 / 2400, 160 / 1600),
    ];
    const plan = planMerges(blocks, [p(0, 1, 2)], 2400 / 1600);
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]!.reason).toBe('not-vertical');
  });

  it('refuses even two horizontal fragments that would have passed every measurement', () => {
    // Adjacent, same glyph, one line each, union barely larger than the parts.
    // Nothing here is distinguishable from one sentence cut in half — which is
    // the point: nor is it distinguishable from two short balloons.
    const line = (x: number): MergeableBlock => ({
      rect: { x, y: 0.2, w: 0.1, h: 30 / 2400 },
      direction: 'horizontal',
      glyph: 30 / 1600,
    });
    expect(planMerges([line(0.2), line(0.32)], [p(0, 1)], 1.5).rejected[0]!.reason).toBe(
      'not-vertical',
    );
  });

  it('refuses blocks at opposite ends of the page, however sure the model is', () => {
    const blocks = [column(0.9, 0.05, 0.3), column(0.05, 0.6, 0.3)];
    expect(planMerges(blocks, [p(0, 1)], ASPECT).rejected[0]!.reason).toBe('not-adjacent');
  });

  it('refuses a chain that reaches across the page one short link at a time', () => {
    // Every link is inside the relaxed gap, but the whole thing encloses far more
    // artwork than text. This is what the union check is for.
    const blocks = Array.from({ length: 6 }, (_, i) => column(0.2 + i * 0.12, 0.3, 0.1));
    const plan = planMerges(blocks, [p(0, 1, 2, 3, 4, 5)], ASPECT);
    expect(plan.accepted).toEqual([]);
    expect(['not-adjacent', 'union-too-large']).toContain(plan.rejected[0]!.reason);
  });

  it('refuses to absorb a sound effect into the dialogue beside it', () => {
    const blocks = [column(0.6, 0.2, 0.2), column(0.55, 0.2, 0.25, GLYPH * 3)];
    expect(planMerges(blocks, [p(0, 1)], ASPECT).rejected[0]!.reason).toBe('glyph-mismatch');
  });

  it('refuses to mix a vertical column with a horizontal caption', () => {
    const blocks: MergeableBlock[] = [
      column(0.6, 0.2, 0.2),
      { rect: { x: 0.55, y: 0.2, w: 0.06, h: 0.02 }, direction: 'horizontal', glyph: GLYPH },
    ];
    expect(planMerges(blocks, [p(0, 1)], ASPECT).rejected[0]!.reason).toBe('mixed-direction');
  });

  it('refuses a union that balloons over the artwork between the parts', () => {
    // Near enough to pass the per-link gap, but the merged rect is mostly empty:
    // a short column beside a long one, offset far enough to enclose both.
    const blocks = [column(0.6, 0.1, 0.04), column(0.56, 0.5, 0.04)];
    const plan = planMerges(blocks, [p(0, 1)], ASPECT, {
      ...MERGE_LIMITS,
      // Neutralise the gap test so the union check is what is being measured.
      gapRelaxation: 100,
    });
    expect(plan.rejected[0]!.reason).toBe('union-too-large');
  });

  it('caps the merged rect as a fraction of the page regardless of the parts', () => {
    const tall = [
      { rect: { x: 0.3, y: 0.05, w: 0.2, h: 0.9 }, direction: 'vertical' as const, glyph: 0.09 },
      { rect: { x: 0.52, y: 0.05, w: 0.2, h: 0.9 }, direction: 'vertical' as const, glyph: 0.09 },
    ];
    // Both parts are dense and adjacent, so neither the slack ratio (1.05) nor
    // the swallowed-artwork check would object. The absolute cap does: the plate
    // would be 38% of the page.
    const plan = planMerges(tall, [p(0, 1)], ASPECT);
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]!.reason).toBe('union-too-large');
  });

  it('refuses a merge that would draw a plate over a panel of artwork', () => {
    // Two large fragments, near enough in glyph terms and dense enough that the
    // slack ratio is only 1.9 — but the merged rect swallows 13% of the page in
    // pure picture. Two correct separate panels beat that.
    const big = [
      { rect: { x: 0.1, y: 0.2, w: 0.14, h: 0.5 }, direction: 'vertical' as const, glyph: 0.06 },
      { rect: { x: 0.5, y: 0.2, w: 0.14, h: 0.5 }, direction: 'vertical' as const, glyph: 0.06 },
    ];
    const plan = planMerges(big, [p(0, 1)], ASPECT, { ...MERGE_LIMITS, gapRelaxation: 4 });
    expect(plan.rejected[0]!.reason).toBe('union-too-large');
  });

  it('rejects malformed proposals without touching the blocks', () => {
    const blocks = [column(0.6, 0.1, 0.3), column(0.555, 0.14, 0.22)];
    expect(planMerges(blocks, [p(0)], ASPECT).rejected[0]!.reason).toBe('too-few');
    expect(planMerges(blocks, [p(0, 9)], ASPECT).rejected[0]!.reason).toBe('bad-index');
    expect(planMerges(blocks, [p(0, -1)], ASPECT).rejected[0]!.reason).toBe('bad-index');
    expect(planMerges(blocks, [p(0, 1.5)], ASPECT).rejected[0]!.reason).toBe('bad-index');
    expect(planMerges(blocks, [{ members: [] }], ASPECT).rejected[0]!.reason).toBe('too-few');
  });

  it('treats a repeated id as one member, not two', () => {
    const blocks = [column(0.6, 0.1, 0.3), column(0.555, 0.14, 0.22)];
    expect(planMerges(blocks, [p(0, 0)], ASPECT).rejected[0]!.reason).toBe('too-few');
  });

  it('refuses more members than one sentence plausibly spans', () => {
    const blocks = Array.from({ length: 8 }, (_, i) => column(0.7 - i * 0.03, 0.2, 0.2));
    expect(
      planMerges(blocks, [{ members: [0, 1, 2, 3, 4, 5, 6, 7] }], ASPECT).rejected[0]!.reason,
    ).toBe('too-many');
  });

  it('gives a block to the first proposal that claims it and no other', () => {
    const blocks = [column(0.6, 0.1, 0.2), column(0.555, 0.1, 0.2), column(0.51, 0.1, 0.2)];
    const plan = planMerges(blocks, [p(0, 1), p(1, 2)], ASPECT);

    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]!.members).toEqual([0, 1]);
    expect(plan.accepted[0]!.proposal).toBe(0);
    expect(plan.rejected[0]!.reason).toBe('already-merged');
    // The index back into the input is what lets the caller find the text that
    // came with the claim, past the gaps the rejections leave.
    expect(plan.rejected[0]!.proposal).toBe(1);
  });

  it('does nothing at all when the model proposes nothing', () => {
    const blocks = [column(0.6, 0.1, 0.2), column(0.555, 0.1, 0.2)];
    expect(planMerges(blocks, [], ASPECT)).toEqual({ accepted: [], rejected: [] });
  });

  it('rejects a block with no measured glyph size rather than guessing one', () => {
    const blocks = [column(0.6, 0.1, 0.2), { ...column(0.555, 0.1, 0.2), glyph: 0 }];
    expect(planMerges(blocks, [p(0, 1)], ASPECT).rejected[0]!.reason).toBe('glyph-mismatch');
    const nan = [column(0.6, 0.1, 0.2), { ...column(0.555, 0.1, 0.2), glyph: Number.NaN }];
    expect(planMerges(nan, [p(0, 1)], ASPECT).rejected[0]!.reason).toBe('glyph-mismatch');
  });

  it('survives a broken aspect', () => {
    const blocks = [column(0.6, 0.1, 0.2), column(0.555, 0.1, 0.2)];
    for (const aspect of [0, -3, Number.NaN]) {
      expect(() => planMerges(blocks, [p(0, 1)], aspect)).not.toThrow();
    }
  });

  it('is deterministic for a given reply', () => {
    const blocks = [column(0.6, 0.1, 0.3), column(0.555, 0.14, 0.22), column(0.51, 0.09, 0.35)];
    const once = planMerges(blocks, [p(0, 1, 2)], ASPECT);
    expect(planMerges(blocks, [p(0, 1, 2)], ASPECT)).toEqual(once);
  });
});
