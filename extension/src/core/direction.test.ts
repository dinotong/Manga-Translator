import { describe, expect, it } from 'vitest';
import type { Direction, PixRect } from '../types';
import { blockGlyph, blockDirection, detectDirection, DIRECTION_DEFAULTS, glyphSize } from './direction';

const line = (rect: PixRect, direction: Direction = 'vertical') => ({ rect, direction });

describe('detectDirection', () => {
  it('calls a tall narrow box a column', () => {
    expect(detectDirection({ x: 0, y: 0, w: 30, h: 200 }, DIRECTION_DEFAULTS.ja)).toBe('vertical');
  });

  it('calls a wide short box a row', () => {
    expect(detectDirection({ x: 0, y: 0, w: 200, h: 24 }, DIRECTION_DEFAULTS.en)).toBe('horizontal');
  });

  it('falls back on a near-square box, per language', () => {
    const square = { x: 0, y: 0, w: 40, h: 40 };
    expect(detectDirection(square, DIRECTION_DEFAULTS.ja)).toBe('vertical');
    expect(detectDirection(square, DIRECTION_DEFAULTS.en)).toBe('horizontal');
  });

  it('falls back rather than dividing by zero', () => {
    expect(detectDirection({ x: 0, y: 0, w: 0, h: 0 }, DIRECTION_DEFAULTS.ja)).toBe('vertical');
  });
});

describe('glyphSize', () => {
  it('measures across the text, not along it', () => {
    expect(glyphSize({ x: 0, y: 0, w: 30, h: 200 }, 'vertical')).toBe(30);
    expect(glyphSize({ x: 0, y: 0, w: 200, h: 24 }, 'horizontal')).toBe(24);
  });
});

describe('blockDirection', () => {
  it('is decided by area, so one stray line cannot flip a column', () => {
    const lines = [
      line({ x: 0, y: 0, w: 30, h: 400 }, 'vertical'),
      line({ x: 40, y: 0, w: 20, h: 15 }, 'horizontal'),
    ];
    expect(blockDirection(lines, 'horizontal')).toBe('vertical');
  });

  it('uses the fallback on a tie', () => {
    const lines = [
      line({ x: 0, y: 0, w: 10, h: 10 }, 'vertical'),
      line({ x: 20, y: 0, w: 10, h: 10 }, 'horizontal'),
    ];
    expect(blockDirection(lines, 'horizontal')).toBe('horizontal');
  });
});

describe('blockGlyph', () => {
  it('is the median column width, not the block width', () => {
    // Three columns of 30px each: the block is 100px wide, a glyph is 30.
    const lines = [
      line({ x: 0, y: 0, w: 30, h: 200 }),
      line({ x: 35, y: 0, w: 30, h: 200 }),
      line({ x: 70, y: 0, w: 30, h: 200 }),
    ];
    expect(blockGlyph(lines, 'vertical')).toBe(30);
  });

  it('is not dragged by a one-character last column', () => {
    const lines = [
      line({ x: 0, y: 0, w: 30, h: 200 }),
      line({ x: 35, y: 0, w: 32, h: 200 }),
      line({ x: 70, y: 0, w: 8, h: 20 }),
    ];
    expect(blockGlyph(lines, 'vertical')).toBe(30);
  });

  it('averages the middle two when there is an even number', () => {
    const lines = [line({ x: 0, y: 0, w: 20, h: 90 }), line({ x: 30, y: 0, w: 30, h: 90 })];
    expect(blockGlyph(lines, 'vertical')).toBe(25);
  });

  it('measures height for horizontal text', () => {
    const lines = [
      line({ x: 0, y: 0, w: 200, h: 24 }, 'horizontal'),
      line({ x: 0, y: 30, w: 180, h: 26 }, 'horizontal'),
    ];
    expect(blockGlyph(lines, 'horizontal')).toBe(25);
  });

  it('says zero rather than guessing when there are no lines', () => {
    expect(blockGlyph([], 'vertical')).toBe(0);
  });
});
