import { describe, expect, it } from 'vitest';
import type { Direction, TextLine } from '../types';
import { groupLinesIntoBlocks, readingOrder, shouldMerge } from './grouping';
import { GROUPING_DEFAULTS } from './grouping';

/** A vertical column of Japanese text: narrow and tall. */
const col = (x: number, y: number, w = 30, h = 200, score = 0.9): TextLine => ({
  rect: { x, y, w, h },
  score,
  direction: 'vertical',
});

/** A horizontal row of Latin text: wide and short. */
const row = (x: number, y: number, w = 200, h = 24, score = 0.9): TextLine => ({
  rect: { x, y, w, h },
  score,
  direction: 'horizontal',
});

const t = (d: Direction) => GROUPING_DEFAULTS[d];

describe('shouldMerge', () => {
  it('merges adjacent columns of the same bubble', () => {
    // 6px apart, well inside one glyph width (30px).
    expect(shouldMerge(col(100, 50), col(64, 50), t('vertical'))).toBe(true);
  });

  it('rejects columns separated by more than a glyph', () => {
    // 70px apart with a 30px glyph: different bubbles.
    expect(shouldMerge(col(100, 50), col(0, 50), t('vertical'))).toBe(false);
  });

  it('rejects columns that barely overlap along the reading axis', () => {
    // Side by side but vertically staggered — two bubbles, not one.
    expect(shouldMerge(col(100, 0, 30, 200), col(64, 180, 30, 200), t('vertical'))).toBe(false);
  });

  it('rejects a sound effect next to body text', () => {
    // 5x the glyph size: onomatopoeia, must not merge into the dialogue.
    expect(shouldMerge(col(100, 50, 30, 200), col(60, 50, 150, 200), t('vertical'))).toBe(false);
  });

  it('never merges across directions', () => {
    expect(shouldMerge(col(100, 50), { ...row(100, 50), direction: 'horizontal' }, t('vertical'))).toBe(
      false,
    );
  });

  it('merges stacked rows of Latin text', () => {
    expect(shouldMerge(row(10, 100), row(10, 132), t('horizontal'))).toBe(true);
  });
});

describe('groupLinesIntoBlocks', () => {
  it('returns nothing for no input', () => {
    expect(groupLinesIntoBlocks([])).toEqual([]);
  });

  it('merges a three-column bubble into one block', () => {
    const blocks = groupLinesIntoBlocks([col(200, 40), col(164, 40), col(128, 40)]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toHaveLength(3);
    expect(blocks[0]!.direction).toBe('vertical');
    // The block rect wraps all three columns.
    expect(blocks[0]!.rect.x).toBe(128);
    expect(blocks[0]!.rect.w).toBe(102);
  });

  it('keeps two distant bubbles apart', () => {
    expect(groupLinesIntoBlocks([col(200, 40), col(164, 40), col(600, 700)])).toHaveLength(2);
  });

  it('chains transitively across a tall bubble', () => {
    // A and C are 72px apart — too far to pair directly — but B bridges them.
    // This is why grouping needs union-find rather than one pairwise pass.
    const blocks = groupLinesIntoBlocks([col(0, 0), col(36, 0), col(72, 0)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toHaveLength(3);
  });

  it('drops low-confidence lines before grouping', () => {
    // Noise below threshold must not drag a real bubble's bounds outward.
    const blocks = groupLinesIntoBlocks([col(200, 40), col(164, 40), col(180, 45, 30, 200, 0.2)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toHaveLength(2);
  });

  it('averages member scores onto the block', () => {
    const blocks = groupLinesIntoBlocks([col(200, 40, 30, 200, 1.0), col(164, 40, 30, 200, 0.6)]);
    expect(blocks[0]!.score).toBeCloseTo(0.8);
  });

  it('handles a page of Latin dialogue', () => {
    const blocks = groupLinesIntoBlocks([row(10, 100), row(10, 132), row(400, 600)]);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.direction === 'horizontal')).toBe(true);
  });

  it('preserves every input line across the output blocks', () => {
    const lines = [col(200, 40), col(164, 40), col(600, 700), row(50, 900)];
    const total = groupLinesIntoBlocks(lines).reduce((n, b) => n + b.lines.length, 0);
    expect(total).toBe(lines.length);
  });
});

describe('readingOrder', () => {
  it('reads right to left for Japanese', () => {
    const blocks = groupLinesIntoBlocks([col(600, 40), col(100, 40)]);
    const ordered = readingOrder(blocks, true);
    expect(ordered[0]!.rect.x).toBe(600);
    expect(ordered[1]!.rect.x).toBe(100);
  });

  it('reads left to right for English', () => {
    const blocks = groupLinesIntoBlocks([row(600, 40), row(100, 40)]);
    const ordered = readingOrder(blocks, false);
    expect(ordered[0]!.rect.x).toBe(100);
  });

  it('reads top to bottom within a column band', () => {
    // Same x, different y: one band, ordered downward.
    const blocks = groupLinesIntoBlocks([col(600, 800), col(600, 40)]);
    const ordered = readingOrder(blocks, true);
    expect(ordered[0]!.rect.y).toBe(40);
    expect(ordered[1]!.rect.y).toBe(800);
  });

  it('finishes the right column before starting the left', () => {
    const blocks = groupLinesIntoBlocks([col(600, 40), col(600, 800), col(100, 40), col(100, 800)]);
    const xs = readingOrder(blocks, true).map((b) => b.rect.x);
    expect(xs).toEqual([600, 600, 100, 100]);
  });

  it('passes single and empty inputs through', () => {
    expect(readingOrder([], true)).toEqual([]);
    expect(readingOrder(groupLinesIntoBlocks([col(0, 0)]), true)).toHaveLength(1);
  });
});
