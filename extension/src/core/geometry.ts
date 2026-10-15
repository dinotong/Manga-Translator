import type { NormRect, PixRect, Size } from '../types';

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const area = (r: PixRect): number => Math.max(0, r.w) * Math.max(0, r.h);

/** Overlap length of two 1-D intervals given as [start, length]. */
export function overlap1d(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.max(0, Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0));
}

/**
 * Overlap of the two intervals as a fraction of the SHORTER one.
 * Shorter, not union: a one-character line beside a ten-character line should
 * still count as fully overlapping, which is exactly the furigana / short-retort
 * case that shows up constantly in manga.
 */
export function overlapRatio(a0: number, aLen: number, b0: number, bLen: number): number {
  const shorter = Math.min(aLen, bLen);
  if (shorter <= 0) return 0;
  return overlap1d(a0, aLen, b0, bLen) / shorter;
}

/** Gap between two intervals along one axis. 0 when they touch or overlap. */
export function gap1d(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.max(0, Math.max(a0, b0) - Math.min(a0 + aLen, b0 + bLen));
}

export function intersection(a: PixRect, b: PixRect): PixRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : { x: 0, y: 0, w: 0, h: 0 };
}

export function iou(a: PixRect, b: PixRect): number {
  const inter = area(intersection(a, b));
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy non-maximum suppression: keep the best box of each duplicate cluster.
 *
 * A DB probability map does not produce clean disjoint blobs. A glyph whose
 * strokes fall just under the threshold splits into two components that both
 * cover most of the same line, and expandBox then grows them into near-copies
 * of each other. Two boxes over one line means that line is cropped, recognized
 * and billed twice, and the overlay draws the same sentence on top of itself.
 *
 * The threshold is deliberately high. At 0.6 two boxes must be almost the same
 * box to be called duplicates; the adjacent columns of vertical Japanese, which
 * do overlap somewhat once expanded, stay well below it. Dropping a real line
 * here is unrecoverable — grouping never sees it again — so this errs towards
 * keeping too much.
 *
 * Ties in score resolve by input order, so the result is stable across runs.
 */
export function suppressOverlaps<T extends { rect: PixRect; score: number }>(
  items: readonly T[],
  maxIou = 0.6,
): T[] {
  // Indices, not the objects themselves: two detections can be structurally
  // identical, and a Set of references would then behave differently from a Set
  // of equal-but-distinct rects.
  const byScore = items
    .map((_, i) => i)
    .sort((a, b) => items[b]!.score - items[a]!.score || a - b);

  const kept: number[] = [];
  for (const i of byScore) {
    if (kept.every((k) => iou(items[k]!.rect, items[i]!.rect) <= maxIou)) kept.push(i);
  }

  // Back to the caller's order: a dedupe pass has no business also re-sorting
  // its input by confidence.
  const keep = new Set(kept);
  return items.filter((_, i) => keep.has(i));
}

/** Smallest rect containing all inputs. Throws on empty — an empty union is a bug upstream. */
export function unionAll(rects: readonly PixRect[]): PixRect {
  const first = rects[0];
  if (!first) throw new Error('unionAll: empty input');
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.w;
  let maxY = first.y + first.h;
  for (let i = 1; i < rects.length; i++) {
    const r = rects[i]!;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Grow a rect by a fraction of its own size, clipped to the bitmap.
 * Detector boxes hug the ink, so feeding them straight to a recognizer clips
 * the outermost strokes. ~6% recovers them.
 */
export function padRect(r: PixRect, ratio: number, bounds: Size): PixRect {
  const dx = r.w * ratio;
  const dy = r.h * ratio;
  const x = Math.max(0, r.x - dx);
  const y = Math.max(0, r.y - dy);
  return {
    x,
    y,
    w: Math.min(bounds.w - x, r.w + dx * 2),
    h: Math.min(bounds.h - y, r.h + dy * 2),
  };
}

/** Pixel space -> normalized [0,1]. Call this once, at the pipeline boundary. */
export function toNorm(r: PixRect, from: Size): NormRect {
  return {
    x: clamp01(r.x / from.w),
    y: clamp01(r.y / from.h),
    w: clamp01(r.w / from.w),
    h: clamp01(r.h / from.h),
  };
}

/** Normalized -> pixel space of any target size. Used by the overlay renderer. */
export function toPix(r: NormRect, to: Size): PixRect {
  return { x: r.x * to.w, y: r.y * to.h, w: r.w * to.w, h: r.h * to.h };
}

/**
 * Where an image's pixels actually land inside its element box.
 *
 * With object-fit: contain there are letterbox bars, and the overlay must sit on
 * the content, not the element. MangaDex renders 3496x4960 into a 507x720 box
 * with `contain`, so getting this wrong shifts every bubble on the page.
 */
export function computeContentBox(
  elementBox: Size,
  natural: Size,
  fit: 'contain' | 'cover' | 'fill' = 'contain',
): PixRect {
  if (fit === 'fill' || natural.w <= 0 || natural.h <= 0) {
    return { x: 0, y: 0, w: elementBox.w, h: elementBox.h };
  }
  const scaleX = elementBox.w / natural.w;
  const scaleY = elementBox.h / natural.h;
  const scale = fit === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
  const w = natural.w * scale;
  const h = natural.h * scale;
  // Centred, which is the `50% 50%` object-position default.
  return { x: (elementBox.w - w) / 2, y: (elementBox.h - h) / 2, w, h };
}
