import type { Direction, PixRect, TextBlock, TextLine } from '../types';
import { blockDirection, glyphSize } from './direction';
import { gap1d, overlapRatio, unionAll } from './geometry';

/**
 * Merge detected lines into blocks — one block should be one speech bubble.
 *
 * This is the load-bearing algorithm of the whole pipeline. manga-ocr reads a
 * whole multi-line bubble in a single pass and returns correctly ordered text,
 * so there is no character-reassembly step to write. What decides output quality
 * instead is whether the crop handed to it contains exactly one bubble:
 *
 *   under-merge -> one bubble becomes several fragments, each translated without
 *                  the rest of its own sentence
 *   over-merge  -> two bubbles become one crop, and the text comes back interleaved
 *
 * Of the two, over-merging is worse: fragments read as terse, but interleaved
 * bubbles read as confident nonsense. Thresholds below lean conservative.
 */

export interface GroupingThresholds {
  /** Reject a merge when glyph sizes differ by more than this factor. */
  maxSizeRatio: number;
  /** Required overlap along the reading axis, as a fraction of the shorter line. */
  minAxisOverlap: number;
  /** Max gap across the reading axis, as a multiple of glyph size. */
  maxPerpGapRatio: number;
  /** Drop lines below this detector confidence before grouping. */
  minScore: number;
}

export const GROUPING_DEFAULTS: Record<Direction, GroupingThresholds> = {
  // Japanese columns sit close together; the gap between columns is roughly one
  // glyph, so anything past ~1.5 is a different bubble.
  vertical: { maxSizeRatio: 1.7, minAxisOverlap: 0.5, maxPerpGapRatio: 1.5, minScore: 0.5 },
  // Latin line spacing is looser relative to cap height, so allow more vertical
  // gap before calling it a separate block.
  horizontal: { maxSizeRatio: 1.7, minAxisOverlap: 0.4, maxPerpGapRatio: 1.8, minScore: 0.5 },
};

/** Reading axis = the direction text flows. Perp axis = how lines stack. */
function axes(rect: PixRect, direction: Direction) {
  return direction === 'vertical'
    ? { axis0: rect.y, axisLen: rect.h, perp0: rect.x, perpLen: rect.w }
    : { axis0: rect.x, axisLen: rect.w, perp0: rect.y, perpLen: rect.h };
}

export function shouldMerge(a: TextLine, b: TextLine, t: GroupingThresholds): boolean {
  if (a.direction !== b.direction) return false;

  const sizeA = glyphSize(a.rect, a.direction);
  const sizeB = glyphSize(b.rect, b.direction);
  if (sizeA <= 0 || sizeB <= 0) return false;

  const ratio = sizeA > sizeB ? sizeA / sizeB : sizeB / sizeA;
  if (ratio > t.maxSizeRatio) return false;

  const ra = axes(a.rect, a.direction);
  const rb = axes(b.rect, b.direction);

  // Lines in one bubble start and end at roughly the same place along the
  // reading axis. Two bubbles stacked diagonally fail this.
  if (overlapRatio(ra.axis0, ra.axisLen, rb.axis0, rb.axisLen) < t.minAxisOverlap) return false;

  // ...and sit within about one glyph of each other across it.
  const perpGap = gap1d(ra.perp0, ra.perpLen, rb.perp0, rb.perpLen);
  return perpGap <= Math.max(sizeA, sizeB) * t.maxPerpGapRatio;
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root]!;
    // Path compression: bubbles chain through many lines, so this matters.
    let cur = i;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Groups are transitive: line A merges with B, B with C, so A/B/C are one block
 * even though A and C may be too far apart to pair directly. That is what a tall
 * bubble looks like, hence union-find rather than a single pass.
 */
export function groupLinesIntoBlocks(
  lines: readonly TextLine[],
  overrides: Partial<Record<Direction, Partial<GroupingThresholds>>> = {},
): TextBlock[] {
  const thresholds: Record<Direction, GroupingThresholds> = {
    vertical: { ...GROUPING_DEFAULTS.vertical, ...overrides.vertical },
    horizontal: { ...GROUPING_DEFAULTS.horizontal, ...overrides.horizontal },
  };

  const kept = lines.filter((l) => l.score >= thresholds[l.direction].minScore);
  if (kept.length === 0) return [];

  const uf = new UnionFind(kept.length);
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i]!;
      const b = kept[j]!;
      if (shouldMerge(a, b, thresholds[a.direction])) uf.union(i, j);
    }
  }

  const groups = new Map<number, TextLine[]>();
  for (let i = 0; i < kept.length; i++) {
    const root = uf.find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(kept[i]!);
    else groups.set(root, [kept[i]!]);
  }

  return [...groups.values()].map((members) => {
    const rect = unionAll(members.map((m) => m.rect));
    const direction = blockDirection(members, members[0]!.direction);
    const score = members.reduce((sum, m) => sum + m.score, 0) / members.length;
    return { rect, direction, lines: members, score };
  });
}

/**
 * Reading order, MVP version: sort blocks into column bands, right-to-left for
 * Japanese, then top-to-bottom inside each band.
 *
 * Overlays are positioned per-block, so this does not affect what the reader
 * sees. It only decides the order text is fed to the translator as context.
 * A proper RTL XY-cut lands later; this is good enough for grid-ish layouts,
 * which is most pages.
 */
export function readingOrder(blocks: readonly TextBlock[], rtl: boolean): TextBlock[] {
  if (blocks.length <= 1) return [...blocks];

  const sorted = [...blocks].sort((a, b) =>
    rtl ? b.rect.x + b.rect.w - (a.rect.x + a.rect.w) : a.rect.x - b.rect.x,
  );

  const bands: TextBlock[][] = [];
  for (const block of sorted) {
    const band = bands.at(-1);
    const ref = band?.[0];
    // Same band when the horizontal spans overlap appreciably.
    if (band && ref && overlapRatio(ref.rect.x, ref.rect.w, block.rect.x, block.rect.w) >= 0.4) {
      band.push(block);
    } else {
      bands.push([block]);
    }
  }

  return bands.flatMap((band) => band.sort((a, b) => a.rect.y - b.rect.y));
}
