/**
 * Which page is the one being read.
 *
 * ## The measurement this exists because of
 *
 * "The page the reader can see never waits for a batch to fill" is the rule that
 * shapes background/read-batcher.ts, and it was implemented as "the image was
 * intersecting the viewport when the job started". On a paged reader that is the
 * same sentence: one page is on screen and everything else is not.
 *
 * On a long strip it is not a sentence at all. Measured on e-hentai MPV and on a
 * luscious album, pages are 1,617-1,834 px tall in a 768 px viewport, so a page
 * overlaps the viewport for several screens of scrolling either side of being
 * read. Nearly every job therefore started while its image was technically on
 * screen, every job was "foreground", and nothing was ever allowed to wait for
 * company: 25 pages, 18 requests, zero batches, even when the pace was forced to
 * 1.3 s per screen. See D-033.
 *
 * So the test is sharpened rather than replaced. The page being read is the one
 * whose middle is nearest the middle of the viewport — which is already how the
 * queue decides what to start first (core/scheduling.ts) — and the rest may
 * wait, on screen or not.
 *
 * ## Why it still has to be on screen
 *
 * Nearest-to-centre on its own would call a page "being read" when the reader
 * has scrolled clear of it and it is the only candidate left, which is exactly
 * the case the on-screen test got right. Both conditions together say what was
 * always meant: of the pages in front of the reader, the one they are looking
 * at. When nothing is in front of them, nothing is foreground and everything may
 * batch.
 */

export interface PageInView {
  /** Whatever the caller uses to name an element. Returned as-is. */
  key: string;
  /** Pixels between the middle of the element and the middle of the viewport. */
  distance: number;
  /** Does the element overlap the viewport at all? */
  onScreen: boolean;
}

/**
 * The key of the page being read, or null when the reader is looking at none of
 * them.
 *
 * Ties go to the earlier entry, so a caller passing pages in document order gets
 * the earlier page — the one a reader moving forwards has already reached.
 */
export function readingNow(pages: readonly PageInView[]): string | null {
  let best: PageInView | null = null;
  for (const page of pages) {
    if (!page.onScreen) continue;
    if (!Number.isFinite(page.distance)) continue;
    if (best === null || page.distance < best.distance) best = page;
  }
  return best?.key ?? null;
}
