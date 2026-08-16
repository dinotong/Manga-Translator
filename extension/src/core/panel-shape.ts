import type { Direction, NormRect } from '../types';

/**
 * The rectangle a translation panel should occupy, which is not always the
 * rectangle the text was found in.
 *
 * Japanese is set in tall narrow columns. Thai is horizontal and has no spaces
 * between words, so `overflow-wrap: anywhere` is the only thing keeping it
 * inside its box — and inside a column three percent of the page wide, "anywhere"
 * means after every single character. The reader gets one glyph per line running
 * down the page: the layout of the source language, in the target language's
 * script, which is precisely the outcome the project set out to avoid.
 *
 * So a panel over vertical text is widened until horizontal text fits in it.
 * Height is left alone rather than reduced with the area, because the panel is
 * also what hides the original: trading a readable line for a column of Japanese
 * peeking out above and below it is not a trade worth making. The panel does
 * cover more art as a result — which is what hover-to-peek is for, and why it
 * defaults to on.
 */

/**
 * How much width to buy per unit of area, as if the panel were being reshaped
 * to this width-to-height ratio.
 *
 * Note what this is *not*: the panel's final ratio. Height is deliberately kept
 * (see above), so the box ends up larger than the block it replaced rather than
 * reshaped to 2.5:1. What the constant actually controls is how fast width
 * grows with the amount of text — a taller column holds more text and gets a
 * proportionally wider panel, which is the behaviour wanted.
 */
export const PANEL_WIDTH_GAIN = 2.5;

/**
 * Floor, as a fraction of image width.
 *
 * Area alone under-serves a short column: two or three characters of vertical
 * Japanese produce so little area that the widened panel is still too narrow
 * for the Thai to be more than a couple of glyphs per line. About an eighth of
 * the page fits a readable short line at any sane font size.
 */
export const MIN_PANEL_WIDTH = 0.14;

/** Never widen past this fraction of the image, however narrow the column. */
export const MAX_PANEL_WIDTH = 0.6;

/**
 * @param rect   detected block, normalized against the image
 * @param aspect natural.h / natural.w — normalized height and width are NOT
 *               comparable without it, since each is divided by a different
 *               dimension
 */
export function panelRect(rect: NormRect, direction: Direction, aspect: number): NormRect {
  // Horizontal source: Thai reads along the same axis the text already occupies,
  // so the detected box is already the right shape.
  if (direction !== 'vertical') return { ...rect };
  if (!Number.isFinite(aspect) || aspect <= 0) return { ...rect };

  // Compare like with like: scale height into width's units before reasoning
  // about shape, then convert back at the end.
  const heightInWidthUnits = rect.h * aspect;
  const area = rect.w * heightInWidthUnits;
  if (area <= 0) return { ...rect };

  const wanted = Math.max(MIN_PANEL_WIDTH, Math.sqrt(area * PANEL_WIDTH_GAIN));

  // Only ever grow. A column already wide enough is left as it is rather than
  // being squeezed to hit the target ratio, which would uncover the text it is
  // supposed to be hiding.
  const width = Math.min(MAX_PANEL_WIDTH, Math.max(rect.w, wanted));

  // Grow about the centre, then slide back inside the image rather than
  // clipping — a panel half off the edge loses the words at that end.
  const centre = rect.x + rect.w / 2;
  const x = Math.min(Math.max(0, centre - width / 2), Math.max(0, 1 - width));

  return { x, y: rect.y, w: width, h: rect.h };
}
