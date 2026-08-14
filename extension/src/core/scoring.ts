/**
 * Is this image a manga page, or a logo?
 *
 * Pure scoring over features the caller reads from the DOM, so the thresholds
 * can be tuned against fixtures instead of against a live website. The numbers
 * are a starting point measured on real readers, not constants worth defending.
 *
 * Deliberately no CSS selectors here: anything site-specific belongs in
 * content/site-profiles.ts, and the moment a hostname appears in this file the
 * separation has failed.
 */

export interface CandidateFeatures {
  /** Intrinsic size of the image. */
  natural: { w: number; h: number };
  /** Size as laid out on screen. Zero for a preloaded, not-yet-shown page. */
  rendered: { w: number; h: number };
  viewport: { w: number; h: number };
  /** id + class + alt, lowercased and joined. */
  text: string;
  /** id + class of the nearest ancestor that has either. */
  ancestorText: string;
  inChrome: boolean;
  inExternalLink: boolean;
}

export const PASS_SCORE = 4;

const READER_HINT = /reader|viewer|page|chapter|comic|manga|gallery/;
const JUNK_HINT = /avatar|icon|logo|thumb|banner|sprite|\bad\b|ads|advert|emoji|badge/;

export function scoreCandidate(f: CandidateFeatures): number {
  const { natural, rendered, viewport } = f;
  let score = 0;

  // Anything this small is furniture, whatever else it scores.
  if (natural.w < 300 || natural.h < 300) return -10;

  if (natural.w >= 500 && natural.h >= 500) score += 3;

  // Rendered area matters, but a preloaded next page legitimately has none —
  // and those are the most valuable pages to work on early, so absence of
  // layout must not be treated as evidence against.
  if (rendered.w > 0 && viewport.w > 0) {
    if (rendered.w >= viewport.w * 0.3) score += 3;
    else if (rendered.w >= viewport.w * 0.15) score += 1;
  } else if (natural.w >= 800) {
    score += 2;
  }

  const aspect = natural.h > 0 ? natural.w / natural.h : 0;
  if (aspect >= 0.45 && aspect <= 1.8) score += 2;
  // Webtoon strip: very tall and very long.
  else if (aspect > 0 && aspect < 0.2 && natural.h > 2000) score += 2;

  if (READER_HINT.test(f.ancestorText) || READER_HINT.test(f.text)) score += 2;
  if (JUNK_HINT.test(f.text)) score -= 5;
  if (f.inChrome) score -= 5;
  if (f.inExternalLink) score -= 2;

  return score;
}

export function isLongStrip(natural: { w: number; h: number }): boolean {
  return natural.w > 0 && natural.h / natural.w > 3;
}
