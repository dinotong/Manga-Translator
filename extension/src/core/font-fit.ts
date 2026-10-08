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
 * Widest average advance of one cell, in em. Measured in Chrome on the overlay's
 * font stack over Thai and Latin phrases: 0.40–0.61. The top of that range, so a
 * line sized with it fits rather than nearly fits.
 */
export const GLYPH_EM = 0.62;

/** `.mt-box` horizontal padding, both sides, in em (styles.ts: `0.3em`). */
const PANEL_PAD_EM = 0.6;

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

let wordSegmenter: Intl.Segmenter | null | undefined;

/**
 * Length in cells of the longest run the browser will not break a line inside.
 *
 * Word boundaries come from `Intl.Segmenter`, which splits Thai by dictionary
 * the same way Chrome's line breaker does, so this agrees with where the panel
 * will actually wrap. Punctuation stays attached to the word before it, as it
 * does on screen. Without `Intl.Segmenter` the whole text counts as one word:
 * the smaller size that gives is safe, a wider panel is not.
 */
export function longestWordGlyphs(text: string): number {
  if (wordSegmenter === undefined) {
    wordSegmenter =
      typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'word' })
        : null;
  }
  if (!wordSegmenter) return Math.max(1, glyphCount(text));
  let longest = 0;
  let run = 0;
  for (const seg of wordSegmenter.segment(text)) {
    if (/^\s+$/u.test(seg.segment)) {
      longest = Math.max(longest, run);
      run = 0;
      continue;
    }
    // A word starts a new run; punctuation and symbols extend the current one.
    if (seg.isWordLike) {
      longest = Math.max(longest, run);
      run = 0;
    }
    run += glyphCount(seg.segment);
  }
  return Math.max(1, longest, run);
}

export interface FontFit {
  /** Area-based size in cqw, already multiplied by the reader's scale. */
  cqw: number;
  /** Readability floor in px, also scaled — a reader who asks for bigger text wants a bigger floor too. */
  minPx: number;
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
  const area = Math.max(MIN_FONT_CQW, Math.min(MAX_FONT_CQW, ideal)) * s;

  // Text wraps between words and never inside one (styles.ts), so the panel
  // widens to its longest word whenever that word does not fit. The area rule
  // knows nothing about words: at the area size a 12-cell phrase in a squat
  // bubble measured +279 px wider than its panel on imhentai, across the next
  // bubble and off the page. Cap the size where the longest word fits the
  // panel. Only the pixel floor may still widen it, which is the growth it
  // exists for.
  //
  // The cap is per word, not per phrase. Capping a whole short phrase to fit
  // one line made it tiny in the narrow panels of vertical bubbles (13 px in a
  // bubble 200 px tall, on the store sample page) when two lines broken
  // between words would have read at twice the size.
  const word = longestWordGlyphs(text);
  const fits = (wCqw * 0.95) / (word * GLYPH_EM + PANEL_PAD_EM);
  const cqw = Math.max(MIN_FONT_CQW * s, Math.min(area, fits));

  return { cqw, minPx: MIN_READABLE_PX * s };
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
