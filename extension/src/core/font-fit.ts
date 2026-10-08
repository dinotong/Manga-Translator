import type { NormRect } from '../types';

/**
 * How big to set the translation inside its panel, and how the panel may grow
 * when that size will not fit.
 *
 * The old rule sized text purely by area and clamped it to [1.2, 6] cqw. Both
 * ends of that clamp are fractions of the *rendered image width*, so the floor
 * meant nothing to the eye: MangaDex in Fit Both draws a page about 507 px wide,
 * where 1.2 cqw is 6 px. Short phrases are exactly the ones that sit in small
 * bubbles and sound effects, so they were the ones that landed on that floor and
 * came out unreadable. Three things change here:
 *
 * 1. Characters are counted as the reader sees them. `.length` counts Thai
 *    vowel and tone marks as characters of their own, though they stack on the
 *    consonant and take no width — "ที่" is three code units in one cell.
 * 2. The floor is in CSS pixels, applied by `max()` in CSS so the overlay still
 *    reflows on resize with no JavaScript.
 * 3. The panel is allowed to grow around its own centre when the floor wins,
 *    instead of clipping or breaking a short word one glyph per line. The cover
 *    plate is positioned from the panel's centre in container units, so a
 *    growing panel does not drag the plate off the ink it hides.
 */

/**
 * Smallest size Thai stays legible at. Stacked vowels and tone marks need more
 * height than Latin at the same nominal size; below about 13 px they merge into
 * the consonant line.
 */
export const MIN_READABLE_PX = 13;

/** Bounds of the area-based size, in cqw. The ceiling stops a two-word bubble becoming a poster. */
export const MIN_FONT_CQW = 1.2;
export const MAX_FONT_CQW = 6;

/**
 * At or under this many glyphs, a translation is one short line and must never
 * be broken inside itself. Thai has no spaces, so `overflow-wrap: anywhere` in a
 * narrow panel splits a four-letter word across four lines — which reads worse
 * than a panel that is a little wider than the bubble.
 */
export const SHORT_TEXT_GLYPHS = 12;

let segmenter: Intl.Segmenter | null | undefined;

/**
 * Number of user-perceived characters (grapheme clusters).
 *
 * Locale is left undefined on purpose: grapheme boundaries are defined by
 * Unicode, not by language, and the project never hardcodes a language code.
 * Where `Intl.Segmenter` is missing, combining marks are dropped and code points
 * counted, which gives the same answer for Thai, Japanese and English.
 */
export function glyphCount(text: string): number {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (segmenter) {
    let n = 0;
    for (const _ of segmenter.segment(text)) n++;
    return n;
  }
  return Array.from(text.replace(/\p{M}/gu, '')).length;
}

export interface FontFit {
  /** Area-based size in cqw, already multiplied by the reader's scale. */
  cqw: number;
  /** Readability floor in px, also scaled — a reader who asks for bigger text wants a bigger floor too. */
  minPx: number;
  /** One short line: the panel may widen to fit it rather than wrap it. */
  short: boolean;
}

/**
 * @param panel  the panel the text is set in, normalized against the image
 * @param aspect natural.h / natural.w — `cqw` is a fraction of WIDTH only, so a
 *               panel's height has to go through the aspect ratio or every tall
 *               vertical bubble is judged far shorter than it is
 * @param scale  the reader's font-size multiplier
 */
export function fitFont(panel: NormRect, aspect: number, text: string, scale: number): FontFit {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const finite = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const wCqw = finite(panel.w) * 100;
  const hCqw = finite(panel.h) * 100 * a;

  // A box holds about w*h / (1.2*s^2) roughly-square glyphs at size s with 1.2
  // line spacing. Solve for s at N glyphs; 0.92 leaves room for padding and
  // imperfect wrapping.
  const glyphs = Math.max(1, glyphCount(text));
  const ideal = Math.sqrt((wCqw * hCqw) / (1.2 * glyphs)) * 0.92;
  const cqw = Math.max(MIN_FONT_CQW, Math.min(MAX_FONT_CQW, ideal)) * s;

  return { cqw, minPx: MIN_READABLE_PX * s, short: glyphs <= SHORT_TEXT_GLYPHS };
}

/** The cover plate as an offset from the panel's centre, in cqw. */
export interface CentredPlate {
  dx: number;
  dy: number;
  w: number;
  h: number;
}

/**
 * Where the cover plate goes, measured from the centre of its panel in `cqw`.
 *
 * Percentages of the panel would be wrong as soon as the panel grows to fit its
 * text: the plate would grow and slide with it and cover art it has no reason
 * to. The panel grows symmetrically about its centre, so an offset from that
 * centre in container units keeps the plate on the ink at any panel size.
 */
export function plateFromCentre(rect: NormRect, panel: NormRect, aspect: number): CentredPlate {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const cx = panel.x + panel.w / 2;
  const cy = panel.y + panel.h / 2;
  return {
    dx: (rect.x - cx) * 100,
    dy: (rect.y - cy) * 100 * a,
    w: rect.w * 100,
    h: rect.h * 100 * a,
  };
}
