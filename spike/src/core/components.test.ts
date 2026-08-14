import { describe, expect, it } from 'vitest';
import type { Size } from '../types';
import { COMPONENT_DEFAULTS, connectedComponents, dilate, inkRatio } from './components';

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

/** Inverse of mask(): render a map back to ASCII so a failure is readable. */
function ascii(map: ArrayLike<number>, size: Size): string[] {
  const rows: string[] = [];
  for (let y = 0; y < size.h; y++) {
    let row = '';
    for (let x = 0; x < size.w; x++) row += (map[y * size.w + x] ?? 0) > 0 ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

const loose = { ...COMPONENT_DEFAULTS, minArea: 1, minSide: 1 };

describe('dilate', () => {
  it('grows a lone point into a square', () => {
    const { map, size } = mask([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ]);
    expect(ascii(dilate(map, size, 1, 1), size)).toEqual([
      '.....',
      '.###.',
      '.###.',
      '.###.',
      '.....',
    ]);
  });

  it('takes the max rather than accumulating — a dilated map is still probabilities', () => {
    // Values chosen to be exact in float32 so the comparison is about the
    // operator, not about rounding.
    const size = { w: 3, h: 1 };
    const map = Float32Array.from([1, 0.5, 0]);
    expect([...dilate(map, size, 1, 0)]).toEqual([1, 1, 0.5]);
  });

  it('joins glyphs that sit within the radius of each other', () => {
    // The reason dilate exists: two kana in one column must label as one line.
    const { map, size } = mask([
      '#....',
      '.....',
      '#....',
    ]);
    expect(connectedComponents(map, size, loose)).toHaveLength(2);
    expect(connectedComponents(dilate(map, size, 0, 1), size, loose)).toHaveLength(1);
  });

  it('leaves glyphs further apart than the radius separate', () => {
    // ...and the reason the radius stays small: two columns must not merge here,
    // that call belongs to grouping.ts.
    const { map, size } = mask([
      '#...#',
      '.....',
      '#...#',
    ]);
    expect(connectedComponents(dilate(map, size, 1, 1), size, loose)).toHaveLength(2);
  });

  it('is a no-op at radius 0', () => {
    const { map, size } = mask([
      '.#..',
      '#.#.',
      '..#.',
    ]);
    expect([...dilate(map, size, 0, 0)]).toEqual([...map]);
  });

  it('applies radiusX and radiusY independently', () => {
    const { map, size } = mask([
      '.....',
      '..#..',
      '.....',
    ]);
    expect(ascii(dilate(map, size, 2, 0), size)).toEqual([
      '.....',
      '#####',
      '.....',
    ]);
    expect(ascii(dilate(map, size, 0, 2), size)).toEqual([
      '..#..',
      '..#..',
      '..#..',
    ]);
  });

  it('clamps at the edges instead of reading past the array', () => {
    // A radius larger than the map would walk off both ends of every row. The
    // symptom would be undefined -> NaN spreading through the mask rather than
    // a thrown error, so assert on the values, not on "it did not crash".
    const { map, size } = mask([
      '#..',
      '...',
      '..#',
    ]);
    const out = dilate(map, size, 9, 9);

    expect(out).toHaveLength(size.w * size.h);
    expect([...out].every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it('accepts a plain array, not just a Float32Array', () => {
    // The detector hands over an ONNX output tensor; tests hand over literals.
    expect([...dilate([0, 1, 0], { w: 3, h: 1 }, 1, 0)]).toEqual([1, 1, 1]);
  });
});

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
