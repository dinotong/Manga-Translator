import { describe, expect, it } from 'vitest';
import type { Size } from '../types';
import { COMPONENT_DEFAULTS, connectedComponents, inkRatio } from './components';

/** Build a probability map from an ASCII sketch. '#' is ink, '.' is background. */
function mask(rows: string[]): { map: Float32Array; size: Size } {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const map = new Float32Array(w * h);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      map[y * w + x] = ch === '#' ? 0.9 : 0.0;
    });
  });
  return { map, size: { w, h } };
}

const loose = { ...COMPONENT_DEFAULTS, minArea: 1, minSide: 1 };

describe('connectedComponents', () => {
  it('finds nothing in an empty map', () => {
    const { map, size } = mask(['....', '....']);
    expect(connectedComponents(map, size, loose)).toEqual([]);
  });

  it('finds a single blob and its bounding box', () => {
    const { map, size } = mask([
      '.....',
      '.##..',
      '.##..',
      '.....',
    ]);
    const comps = connectedComponents(map, size, loose);

    expect(comps).toHaveLength(1);
    expect(comps[0]!.rect).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(comps[0]!.pixels).toBe(4);
  });

  it('separates blobs that only touch diagonally', () => {
    // 4-connectivity on purpose: adjacent columns of vertical Japanese text
    // often touch at the corners, and merging them here would rob grouping.ts
    // of the decision it exists to make.
    const { map, size } = mask([
      '#...',
      '.#..',
      '..#.',
    ]);
    expect(connectedComponents(map, size, loose)).toHaveLength(3);
  });

  it('joins pixels connected through a thin bridge', () => {
    const { map, size } = mask([
      '##.##',
      '#####',
      '##.##',
    ]);
    expect(connectedComponents(map, size, loose)).toHaveLength(1);
  });

  it('drops components below the area floor', () => {
    const { map, size } = mask([
      '#....',
      '.....',
      '..###',
      '..###',
    ]);
    const comps = connectedComponents(map, size, { ...loose, minArea: 4 });

    expect(comps).toHaveLength(1);
    expect(comps[0]!.pixels).toBe(6);
  });

  it('drops components thinner than the side floor', () => {
    // A one-pixel rule: panel border, not text.
    const { map, size } = mask([
      '#####',
      '.....',
    ]);
    expect(connectedComponents(map, size, { ...loose, minSide: 2 })).toEqual([]);
  });

  it('respects the probability threshold', () => {
    const size = { w: 2, h: 2 };
    const map = Float32Array.from([0.9, 0.9, 0.2, 0.2]);

    expect(connectedComponents(map, size, { ...loose, threshold: 0.5 })[0]!.rect.h).toBe(1);
    expect(connectedComponents(map, size, { ...loose, threshold: 0.1 })[0]!.rect.h).toBe(2);
  });

  it('scores a component by mean probability', () => {
    const size = { w: 2, h: 1 };
    const map = Float32Array.from([1.0, 0.6]);
    expect(connectedComponents(map, size, loose)[0]!.score).toBeCloseTo(0.8);
  });

  it('finds two columns of a bubble as separate components', () => {
    // Grouping merges these later; the detector should not do it here.
    const { map, size } = mask([
      '#.#',
      '#.#',
      '#.#',
      '#.#',
    ]);
    const comps = connectedComponents(map, size, loose);

    expect(comps).toHaveLength(2);
    expect(comps.every((c) => c.rect.h === 4 && c.rect.w === 1)).toBe(true);
  });

  it('survives a mask that fills the whole map without overflowing the stack', () => {
    const size = { w: 300, h: 300 };
    const map = new Float32Array(size.w * size.h).fill(0.9);
    const comps = connectedComponents(map, size, loose);

    expect(comps).toHaveLength(1);
    expect(comps[0]!.pixels).toBe(90_000);
  });

  it('returns nothing when the map is shorter than the declared size', () => {
    expect(connectedComponents(new Float32Array(10), { w: 100, h: 100 }, loose)).toEqual([]);
  });
});

describe('inkRatio', () => {
  it('is 0 for a blank white crop', () => {
    expect(inkRatio(new Float32Array(100).fill(1), { w: 10, h: 10 })).toBe(0);
  });

  it('is small for a crop with a little text', () => {
    const gray = new Float32Array(100).fill(1);
    for (let i = 0; i < 5; i++) gray[i] = 0;
    expect(inkRatio(gray, { w: 10, h: 10 })).toBeCloseTo(0.05);
  });

  it('treats white-on-black the same as black-on-white', () => {
    // A mostly black panel with white text is 5% ink, not 95%.
    const gray = new Float32Array(100).fill(0);
    for (let i = 0; i < 5; i++) gray[i] = 1;
    expect(inkRatio(gray, { w: 10, h: 10 })).toBeCloseTo(0.05);
  });

  it('is 0 for an empty crop instead of dividing by zero', () => {
    expect(inkRatio(new Float32Array(0), { w: 0, h: 0 })).toBe(0);
  });
});
