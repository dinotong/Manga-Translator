import type { Size } from '../types';

/**
 * How big a bitmap to hand each stage.
 *
 * Detection wants enough pixels to find small text but not more; recognition
 * crops from a slightly larger bitmap so glyph edges survive. Both are capped by
 * the source, because upscaling adds work without adding information.
 */
export interface ResolutionPolicy {
  /** Target long edge for the detection bitmap. */
  detTarget: number;
  /** Target long edge for the bitmap crops are taken from. */
  recTarget: number;
}

export const PRESETS = {
  fast: { detTarget: 1024, recTarget: 1280 },
  balanced: { detTarget: 1600, recTarget: 2048 },
  quality: { detTarget: 2048, recTarget: 3072 },
} as const satisfies Record<string, ResolutionPolicy>;

export type PresetName = keyof typeof PRESETS;

/**
 * Scale a source down to a target long edge — never up.
 *
 * The clamp is the whole point. MangaDex pages are 3496px wide and genuinely
 * need downscaling; imhentai pages are 1280px and a naive "resize to 1600"
 * would enlarge them, costing ~1.5x the OCR time for zero extra detail.
 */
export function fitLongEdge(natural: Size, target: number): Size {
  const longEdge = Math.max(natural.w, natural.h);
  if (longEdge <= 0) return { w: 0, h: 0 };

  const scale = Math.min(1, target / longEdge);
  return {
    w: Math.max(1, Math.round(natural.w * scale)),
    h: Math.max(1, Math.round(natural.h * scale)),
  };
}

export function planResolution(natural: Size, policy: ResolutionPolicy) {
  return {
    det: fitLongEdge(natural, policy.detTarget),
    rec: fitLongEdge(natural, policy.recTarget),
  };
}

/**
 * Rough glyph height in the detection bitmap, for warning the user before we
 * waste time on an unreadable page.
 *
 * Shonen Jump+ renders its canvas at 371px wide, which puts bubble text around
 * 8-12px tall — below what manga-ocr was trained on. Better to say "zoom in"
 * than to return confident nonsense.
 */
export function estimateGlyphPx(detSize: Size, glyphsPerLongEdge = 60): number {
  return Math.max(detSize.w, detSize.h) / glyphsPerLongEdge;
}

export const MIN_USABLE_GLYPH_PX = 14;

export function resolutionWarning(detSize: Size): string | null {
  const glyph = estimateGlyphPx(detSize);
  if (glyph >= MIN_USABLE_GLYPH_PX) return null;
  return `Estimated glyph height ~${glyph.toFixed(1)}px (need >=${MIN_USABLE_GLYPH_PX}px). Zoom the page in or maximise the window, then retry.`;
}
