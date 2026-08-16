/**
 * Is this page offering images to *read*, or images to *choose from*?
 *
 * The per-image scorer in scoring.ts cannot answer this and never will. A cover
 * is a manga image: portrait, drawn, often with Japanese text, sitting on a
 * manga site. Nothing about the picture separates it from a real page. What
 * makes translating it wrong is the page around it — a listing hands you a wall
 * of covers to pick from, a reader hands you one thing to read.
 *
 * So this works on the *shape of the page*: how the candidate images are laid
 * out relative to the viewport, not what is inside them.
 *
 * Measured on 2026-08-15 across four viewport sizes (1366x768, 1920x1080,
 * 2560x1080, 1280x1400) on MangaDex, imhentai and mangaread.org — see D-030 for
 * the table. The numbers below come from that sweep, not from a guess, but they
 * are still only the numbers that separated eleven page types, not constants
 * worth defending.
 */

export interface LaidOutBox {
  /** getBoundingClientRect size. Zero for a preloaded page with no layout yet. */
  w: number;
  h: number;
  /**
   * getBoundingClientRect().top — distance from the top of the viewport, so
   * negative means scrolled past.
   *
   * Optional, and absent means "near enough to count". Every fixture written
   * before this existed described a single screenful, which is exactly what
   * that default preserves.
   */
  top?: number;
}

export interface PageShape {
  viewport: { w: number; h: number };
  /** Every image the per-image scorer already accepted as a possible page. */
  candidates: readonly LaidOutBox[];
}

export type PageKind = 'reader' | 'listing';

/**
 * A candidate is "dominant" when it takes over the viewport in either axis.
 *
 * Both axes are needed, and width alone is the trap. A paged reader that fits
 * the page to the window height renders it at 30% of the width on a 2560px
 * monitor (measured: MangaDex 0.301, imhentai 0.313) while still being the only
 * thing on screen — a width-only rule calls that a listing and stops working
 * for anyone with a wide monitor. Height catches it: those same pages measured
 * 1.0 and 1.055 of the viewport height.
 */
export const DOMINANT_WIDTH = 0.5;
export const DOMINANT_HEIGHT = 0.6;

/**
 * How many non-dominant candidates a reader page is allowed to carry.
 *
 * A reader is not always spotless — MangaDex's chapter view has a payment-logo
 * image that the scorer waves through, and the widest window turned one strip of
 * a webtoon chapter into a non-dominant box. Both measured at exactly one. A
 * listing that *does* contain something dominant (MangaDex's front page, whose
 * hero carousel covers 86% of the width) carried eight. Two is the gap: enough
 * slack for the odd stray, far below any real grid of covers.
 */
export const MAX_BYSTANDERS = 2;

/**
 * How far from the viewport a candidate may sit and still count as evidence.
 *
 * In viewport heights, above and below. This is the rule that makes long-strip
 * galleries work at all, and it was measured rather than guessed: on a
 * luscious.net album the reader is a vertical strip of full-width pages, and the
 * document *also* carries a nine-image "you might also like" rail at the very
 * bottom. Measured at three scroll positions, that rail sat 26,937-54,435 px
 * below the viewport — between 35 and 71 screens away — while the pages being
 * read were all within ±3,000 px. Counting the rail put bystanders at nine
 * against a limit of two, so every album on that site was classified as a
 * listing and auto-translate never ran: measured, 38 pages scrolled past in four
 * minutes produced zero requests and zero overlays.
 *
 * Two screens is not an arbitrary radius. It is the same distance
 * `entrypoints/content.ts` already uses for its IntersectionObserver margin —
 * the region the pipeline is willing to start work in. Judging the shape of the
 * page over exactly the region we would act on is the only version of this that
 * stays consistent as the reader scrolls.
 *
 * It does not weaken the listing case that MAX_BYSTANDERS exists for: MangaDex's
 * front page puts its hero carousel and its eight covers on the same screen, so
 * all nine remain in range and it is still a listing.
 */
export const EVIDENCE_SCREENS = 2;

/**
 * The verdict.
 *
 * Note which way this leans. "No candidate dominates" is a listing, and so is
 * "nothing has been laid out yet" — the answer when we cannot tell is the answer
 * that spends nothing and covers nothing. The two mistakes are not equally
 * priced: translating a listing burns quota from a 1,000/day budget *and* paints
 * over the covers the reader is trying to look at, while missing a real page
 * costs one right-click.
 *
 * A page that has no layout yet is judged again on the next call — the caller is
 * expected to ask afresh rather than remember this, because on MangaDex the
 * first honest answer arrives only once the blob has decoded.
 */
export function classifyPage(shape: PageShape): PageKind {
  const { viewport } = shape;
  if (viewport.w <= 0 || viewport.h <= 0) return 'listing';

  let dominant = 0;
  let bystanders = 0;
  for (const box of shape.candidates) {
    // No box at all: a preloaded next page. It is not evidence in either
    // direction, and counting it as a bystander would make MangaDex — which
    // keeps the next two pages in the DOM at 0x0 — look like a listing.
    if (box.w <= 0 || box.h <= 0) continue;
    if (!inEvidenceRange(box, viewport.h)) continue;
    if (box.w >= viewport.w * DOMINANT_WIDTH || box.h >= viewport.h * DOMINANT_HEIGHT) dominant++;
    else bystanders++;
  }

  if (dominant === 0) return 'listing';
  if (bystanders > MAX_BYSTANDERS) return 'listing';
  return 'reader';
}

/**
 * Is this box close enough to the reader to say anything about what they are
 * doing?
 *
 * A box with no recorded position counts — see `LaidOutBox.top`.
 */
export function inEvidenceRange(box: LaidOutBox, viewportHeight: number): boolean {
  if (box.top === undefined) return true;
  const margin = viewportHeight * EVIDENCE_SCREENS;
  return box.top < viewportHeight + margin && box.top + box.h > -margin;
}
