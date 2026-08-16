import type { Direction, NormRect } from '../types';

/**
 * The two rectangles a translated bubble needs, and how opaque each may be.
 *
 * There are two jobs here and they want opposite things.
 *
 * **Hiding the original** wants the smallest rectangle that covers the ink, and
 * wants it opaque. Anything wider is artwork destroyed for nothing.
 *
 * **Carrying the Thai** wants a rectangle wide enough to set a horizontal line
 * in, and would rather be nearly transparent so the picture still reads through
 * the words. Japanese is set in tall narrow columns; Thai is horizontal and has
 * no spaces between words, so `overflow-wrap: anywhere` is the only thing
 * keeping it inside its box — and inside a column three percent of the page
 * wide, "anywhere" means after every single character. The reader gets one glyph
 * per line running down the page: the layout of the source language, in the
 * target language's script, which is precisely the outcome the project set out
 * to avoid.
 *
 * One element cannot serve both. Widening it so the Thai reads also widens the
 * opaque plate, and a large part of the page disappears under white. So the two
 * are separated: `panelRect` gives the panel the text is set in, the detected
 * rect stays as the cover plate, and `plateAlphaOver` says how to paint the
 * plate given that it sits on top of the panel.
 *
 * Height is left alone when widening rather than reduced to keep the area,
 * because a shorter panel would let the column of Japanese peek out above and
 * below the plate under it.
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

/** Nothing outside [0,1] is a meaningful alpha; a broken value reads as opaque. */
export function clampOpacity(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/**
 * How opaque to actually paint the cover plate, given it is drawn **on top of**
 * the text panel.
 *
 * The plate always lies inside the panel — `panelRect` only ever grows the box
 * outwards from the same centre — so wherever the plate is, two translucent
 * layers stack. Painting both at the values the reader chose would composite to
 * `1-(1-plate)(1-panel)`, which is darker than either of them asked for, and
 * worst exactly where the two rects coincide: horizontal text, where the panel
 * is not widened at all and the reader would get a double-strength plate for
 * settings that say nothing of the sort.
 *
 * So the plate is painted at whatever alpha makes the stack come out at
 * `max(plate, panel)`: the plate's own value where it is the stronger of the
 * two, the panel's where it is not, and never more than one of them anywhere.
 * A plate that would add nothing returns 0 and is not drawn at all, which is
 * also how the coincident case avoids putting a second element on the page.
 */
export function plateAlphaOver(plateOpacity: number, panelOpacity: number): number {
  const plate = clampOpacity(plateOpacity);
  const panel = clampOpacity(panelOpacity);
  if (plate <= panel) return 0;
  // An opaque panel already hides everything; nothing can be added on top of it.
  if (panel >= 1) return 0;
  return (plate - panel) / (1 - panel);
}

/**
 * The cover plate expressed in the panel's own coordinate frame, because that is
 * where it is drawn: as a child of the panel element, so hover, peeking and
 * hit-testing all keep treating one bubble as one thing.
 *
 * Both inputs are normalized against the image; the result is normalized against
 * the panel, ready to become CSS percentages.
 */
export function plateInPanel(rect: NormRect, panel: NormRect): NormRect {
  if (panel.w <= 0 || panel.h <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  return {
    x: (rect.x - panel.x) / panel.w,
    y: (rect.y - panel.y) / panel.h,
    w: rect.w / panel.w,
    h: rect.h / panel.h,
  };
}
