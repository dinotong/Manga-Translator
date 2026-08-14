import type { PixRect, Size } from '../types';

/**
 * Connected-component extraction over a binary mask.
 *
 * PP-OCR's detector is a DB (differentiable binarization) model: it outputs a
 * per-pixel probability map, not boxes. Turning that map into line rectangles is
 * our job, and it is the one genuinely fiddly part of the detector. Keeping it
 * here — pure, on plain arrays — means it can be tested without ONNX, a GPU, or
 * a browser, and tuned against fixtures in milliseconds.
 */

export interface ComponentOptions {
  /** Probability above which a pixel counts as ink. */
  threshold: number;
  /** Discard components smaller than this many pixels (noise, screentone dots). */
  minArea: number;
  /** Discard components thinner than this on either side (panel borders, speckle). */
  minSide: number;
}

export const COMPONENT_DEFAULTS: ComponentOptions = {
  threshold: 0.3,
  minArea: 24,
  minSide: 3,
};

export interface Component {
  rect: PixRect;
  /** Number of ink pixels, not the rect area. */
  pixels: number;
  /** Mean probability over the component's pixels — becomes the line score. */
  score: number;
}

/**
 * Grow the ink mask so neighbouring glyphs join into a line before labelling.
 *
 * Japanese glyphs are separate blobs of ink with clear gaps between them, so
 * running connected components straight on the raw probability map returns one
 * component per CHARACTER, not per line. Downstream that is fatal: each stray
 * kana becomes its own "bubble", gets sent to the translator alone, and comes
 * back as nonsense — while the sentence it belonged to is never assembled.
 *
 * PaddleOCR's own postprocess handles this by unclipping the polygon; for
 * axis-aligned boxes, dilating the mask first is the equivalent and much
 * simpler. Separable (horizontal pass, then vertical) so the cost stays linear
 * in radius rather than quadratic.
 *
 * Radius is asymmetric on purpose: it must bridge the gap BETWEEN glyphs in a
 * column without also bridging the gap between two adjacent columns, which is
 * grouping.ts's decision to make.
 */
export function dilate(
  probMap: Readonly<ArrayLike<number>>,
  size: Size,
  radiusX: number,
  radiusY: number,
): Float32Array {
  const { w, h } = size;
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let max = 0;
      const from = Math.max(0, x - radiusX);
      const to = Math.min(w - 1, x + radiusX);
      for (let k = from; k <= to; k++) {
        const v = probMap[row + k] ?? 0;
        if (v > max) max = v;
      }
      tmp[row + x] = max;
    }
  }

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let max = 0;
      const from = Math.max(0, y - radiusY);
      const to = Math.min(h - 1, y + radiusY);
      for (let k = from; k <= to; k++) {
        const v = tmp[k * w + x] ?? 0;
        if (v > max) max = v;
      }
      out[y * w + x] = max;
    }
  }

  return out;
}

/**
 * Label 4-connected regions of `probMap` (row-major, length = size.w * size.h).
 *
 * Iterative flood fill with an explicit stack: a full-page text mask can span
 * hundreds of thousands of pixels, and recursion blows the stack well before
 * that.
 */
export function connectedComponents(
  probMap: Readonly<ArrayLike<number>>,
  size: Size,
  opts: ComponentOptions = COMPONENT_DEFAULTS,
): Component[] {
  const { w, h } = size;
  if (w <= 0 || h <= 0 || probMap.length < w * h) return [];

  const seen = new Uint8Array(w * h);
  const out: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (seen[start] === 1) continue;
    seen[start] = 1;
    if ((probMap[start] ?? 0) < opts.threshold) continue;

    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let pixels = 0;
    let probSum = 0;

    stack.push(start);
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;

      pixels++;
      probSum += probMap[idx] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 4-connectivity. 8 would bridge adjacent columns of vertical text into
      // one blob, which is exactly the merge decision grouping.ts should own.
      if (x > 0) pushIfInk(idx - 1);
      if (x < w - 1) pushIfInk(idx + 1);
      if (y > 0) pushIfInk(idx - w);
      if (y < h - 1) pushIfInk(idx + w);
    }

    const rect: PixRect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    if (pixels >= opts.minArea && rect.w >= opts.minSide && rect.h >= opts.minSide) {
      out.push({ rect, pixels, score: probSum / pixels });
    }
  }

  return out;

  function pushIfInk(next: number): void {
    if (seen[next] === 1) return;
    seen[next] = 1;
    if ((probMap[next] ?? 0) >= opts.threshold) stack.push(next);
  }
}

/**
 * Fraction of a crop that is ink.
 *
 * manga-ocr always returns *something* — hand it a blank panel and it will
 * invent a plausible Japanese sentence. An ink-ratio floor is the cheapest of
 * the guards against that, applied before recognition rather than after.
 */
export function inkRatio(
  gray: Readonly<ArrayLike<number>>,
  size: Size,
  darkBelow = 0.5,
): number {
  const n = Math.min(gray.length, size.w * size.h);
  if (n <= 0) return 0;

  let dark = 0;
  for (let i = 0; i < n; i++) if ((gray[i] ?? 1) < darkBelow) dark++;

  // White text on black is just as much "ink"; fold the two cases together so a
  // black-background panel is not mistaken for a solid block of text.
  const ratio = dark / n;
  return ratio > 0.5 ? 1 - ratio : ratio;
}
