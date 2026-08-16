import type { Direction, NormRect } from '../types';
import { gap1d, unionAll } from './geometry';
import { GROUPING_DEFAULTS } from './grouping';

/**
 * Letting the model say which detected blocks are one continuous text, and
 * letting geometry refuse.
 *
 * ## Why the model gets a say at all
 *
 * `grouping.ts` decides where one bubble ends and the next begins from geometry
 * alone: how far apart two columns sit, and how much they overlap along the
 * reading axis. Those thresholds were fitted to printed speech bubbles, where
 * columns start together, end together and are spaced by a typesetter. An
 * afterword page — freeform handwriting over the artwork, columns of uneven
 * length starting at different heights, spacing that varies by the sentence —
 * breaks both assumptions at once, and one sentence comes back as three or four
 * fragments, each translated with no sight of the rest of itself.
 *
 * No threshold answers that correctly on every page, because the question is not
 * really geometric: whether three columns are one sentence or three is a fact
 * about the *language*. The model already receives every crop from the page in
 * one request and has read all of them, so it is the only party in the pipeline
 * that knows.
 *
 * ## Why it is a proposal and not an instruction
 *
 * Over-merging is the worst failure this project has (see grouping.ts): two
 * characters speaking in adjacent bubbles, merged, produce one fluent confident
 * translation covering both, and the reader has no way to notice. A model that
 * is wrong about that is wrong in exactly the way that does the most damage. So
 * a proposal is accepted only where it also passes geometric sanity, and the
 * checks are chosen to bound the blast radius to the failure actually being
 * fixed:
 *
 *   - **Near already.** Both gaps, along and across the reading axis, must be
 *     inside a bounded relaxation of the thresholds `grouping.ts` already uses.
 *     Blocks at opposite ends of the page never merge, however confident the
 *     model is.
 *   - **Fragments only.** Every member must be at most a couple of glyphs across
 *     — a stray column, not a bubble. A block wide enough to be a whole bubble
 *     of its own is never absorbed into anything, which is what protects the
 *     adjacent-speakers case directly rather than by threshold luck.
 *   - **Comparable glyphs.** A sound effect is not part of the dialogue beside
 *     it, whatever it reads like.
 *   - **No ballooning.** A merged rect much larger than the sum of its parts is
 *     a plate over the artwork between two bubbles, which is worse than two
 *     correct separate panels.
 *
 * Rejecting a proposal costs nothing: the blocks stay exactly as `grouping.ts`
 * left them, which is today's behaviour.
 */

/** A detected block, as much of it as this decision needs. */
export interface MergeableBlock {
  rect: NormRect;
  direction: Direction;
  /**
   * Size of one glyph across the reading direction, in image-width units — the
   * same units everything below is measured in.
   *
   * Measured from the detected *lines* upstream, not derived from the block. A
   * block's own width is one glyph for a single column and five for a bubble, so
   * using it here would make every gap test five times too generous on exactly
   * the blocks that most need the test.
   */
  glyph: number;
}

/** What the model claims: these blocks are one continuous text. */
export interface MergeProposal {
  /** Indices into the block list. */
  members: readonly number[];
}

export interface AcceptedMerge {
  /** Ascending, which is reading order — the blocks arrive already sorted. */
  members: number[];
  rect: NormRect;
  /**
   * Which proposal this was, by position in the input.
   *
   * The caller holds the text that came with the claim, and rejected proposals
   * leave gaps in `accepted`, so an index back into the input is the only way to
   * reunite the two without matching on member lists.
   */
  proposal: number;
}

export type MergeRejection =
  | 'too-few'
  | 'too-many'
  | 'bad-index'
  | 'already-merged'
  | 'mixed-direction'
  | 'glyph-mismatch'
  | 'not-a-fragment'
  | 'not-adjacent'
  | 'union-too-large';

export interface RejectedMerge {
  members: number[];
  reason: MergeRejection;
  proposal: number;
}

export interface MergePlan {
  accepted: AcceptedMerge[];
  rejected: RejectedMerge[];
}

export interface MergeLimits {
  /**
   * Members in one merge.
   *
   * Six columns of handwriting is a long sentence; past that the model is more
   * likely describing a whole page of text than one continuous thought, and the
   * union check would usually have caught it anyway.
   */
  maxMembers: number;
  /**
   * How far past the automatic rule a proposal may push, as a multiple of it.
   *
   * Two, so the numbers stay derived from `GROUPING_DEFAULTS` rather than
   * invented next to them: whatever those thresholds become, this stays "twice
   * as far as we would go on our own, and no further". Vertical Japanese
   * therefore allows a gap of 3 glyphs where automatic grouping allows 1.5.
   * Measured against the thing it must not break: bubble-to-bubble gaps include
   * two bubble outlines and their white space, which is several glyphs wider.
   */
  gapRelaxation: number;
  /**
   * Widest a member may be across the reading axis, in glyphs.
   *
   * The line between a fragment and a bubble. Under-merging leaves single
   * columns, occasionally a pair that did group; a printed bubble is three or
   * more. 2.5 sits in that gap.
   */
  maxFragmentGlyphs: number;
  /**
   * Union area over the summed area of the parts.
   *
   * Scale-free, and it catches the case the absolute check below cannot: two
   * small fragments at opposite corners of a modest box, where the plate is not
   * large but is almost entirely empty.
   *
   * Note what the floor is. Two columns side by side but not level with each
   * other give a union about twice as wide and about as tall as the sum, so
   * *every* staggered pair scores at least 2 — which is exactly the arrangement
   * this whole file exists to allow. A ratio limit therefore cannot be tight;
   * 3.5 leaves room for a real stagger and still rejects a pair whose parts are
   * a fifteenth of the box they would be merged into.
   */
  maxUnionSlack: number;
  /**
   * Artwork swallowed by the merge — union minus the parts — as a fraction of
   * the page.
   *
   * The one that has teeth against the failure the brief names: a plate drawn
   * over the picture between two bubbles. 5% of the page is roughly a small
   * panel, and past that two correct separate panels are plainly the better
   * outcome, whatever the ratio says.
   */
  maxEmptyArea: number;
  /** Union area as a fraction of the whole page, whatever the parts add up to. */
  maxUnionArea: number;
}

export const MERGE_LIMITS: MergeLimits = {
  maxMembers: 6,
  gapRelaxation: 2,
  maxFragmentGlyphs: 2.5,
  maxUnionSlack: 3.5,
  maxEmptyArea: 0.05,
  maxUnionArea: 0.3,
};

/**
 * @param blocks   detected blocks, in reading order
 * @param aspect   natural.h / natural.w, so heights and widths are comparable
 */
export function planMerges(
  blocks: readonly MergeableBlock[],
  proposals: readonly MergeProposal[],
  aspect: number,
  limits: MergeLimits = MERGE_LIMITS,
): MergePlan {
  const k = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const accepted: AcceptedMerge[] = [];
  const rejected: RejectedMerge[] = [];
  // First proposal wins any block it names. Order is the model's, and keeping it
  // makes the outcome reproducible for a given reply rather than dependent on
  // which overlapping claim happened to be checked first.
  const taken = new Set<number>();

  proposals.forEach((proposal, index) => {
    const members = [...new Set(proposal.members)].sort((a, b) => a - b);
    const reason = veto(blocks, members, taken, k, limits);
    if (reason) {
      rejected.push({ members, reason, proposal: index });
      return;
    }
    for (const m of members) taken.add(m);
    accepted.push({
      members,
      rect: unionAll(members.map((m) => blocks[m]!.rect)),
      proposal: index,
    });
  });

  return { accepted, rejected };
}

function veto(
  blocks: readonly MergeableBlock[],
  members: readonly number[],
  taken: ReadonlySet<number>,
  aspect: number,
  limits: MergeLimits,
): MergeRejection | null {
  if (members.length < 2) return 'too-few';
  if (members.length > limits.maxMembers) return 'too-many';
  if (members.some((m) => !Number.isInteger(m) || m < 0 || m >= blocks.length)) return 'bad-index';
  if (members.some((m) => taken.has(m))) return 'already-merged';

  const parts = members.map((m) => blocks[m]!);
  const direction = parts[0]!.direction;
  if (parts.some((p) => p.direction !== direction)) return 'mixed-direction';

  const glyphs = parts.map((p) => p.glyph);
  if (glyphs.some((g) => !Number.isFinite(g) || g <= 0)) return 'glyph-mismatch';
  const spread = Math.max(...glyphs) / Math.min(...glyphs);
  if (spread > GROUPING_DEFAULTS[direction].maxSizeRatio) return 'glyph-mismatch';

  const squares = parts.map((p) => square(p.rect, aspect));
  for (let i = 0; i < parts.length; i++) {
    const across = direction === 'vertical' ? squares[i]!.w : squares[i]!.h;
    if (across > glyphs[i]! * limits.maxFragmentGlyphs) return 'not-a-fragment';
  }

  if (!connected(squares, glyphs, direction, limits)) return 'not-adjacent';

  const union = unionAll(squares);
  const sum = squares.reduce((n, r) => n + r.w * r.h, 0);
  const unionArea = union.w * union.h;
  if (unionArea > sum * limits.maxUnionSlack) return 'union-too-large';
  // The page is 1 wide and `aspect` tall in this space.
  const page = aspect;
  if (unionArea - sum > page * limits.maxEmptyArea) return 'union-too-large';
  if (unionArea > page * limits.maxUnionArea) return 'union-too-large';

  return null;
}

/**
 * Every member reachable from every other through a chain of near neighbours.
 *
 * A chain, not all pairs: a sentence running down four columns has a first and a
 * last column that are genuinely far apart, and demanding they be near each
 * other would reject the case this exists for. What a chain still forbids is a
 * proposal that reaches across the page, because every link in it has to be
 * short.
 */
function connected(
  rects: readonly NormRect[],
  glyphs: readonly number[],
  direction: Direction,
  limits: MergeLimits,
): boolean {
  const allowance = GROUPING_DEFAULTS[direction].maxPerpGapRatio * limits.gapRelaxation;
  const seen = new Set<number>([0]);
  const stack = [0];

  while (stack.length > 0) {
    const i = stack.pop()!;
    for (let j = 0; j < rects.length; j++) {
      if (seen.has(j)) continue;
      const reach = Math.max(glyphs[i]!, glyphs[j]!) * allowance;
      const a = rects[i]!;
      const b = rects[j]!;
      // Near in *both* directions. The automatic rule asks for overlap along the
      // reading axis, which is precisely what staggered handwritten columns fail;
      // proximity is the honest weaker form of the same question, and it is what
      // keeps "one sentence over four columns" apart from "two bubbles".
      if (
        gap1d(a.x, a.w, b.x, b.w) <= reach &&
        gap1d(a.y, a.h, b.y, b.h) <= reach
      ) {
        seen.add(j);
        stack.push(j);
      }
    }
  }

  return seen.size === rects.length;
}

/** y scaled into width's units, so a gap across and a gap along mean the same thing. */
function square(r: NormRect, aspect: number): NormRect {
  return { x: r.x, y: r.y * aspect, w: r.w, h: r.h * aspect };
}
