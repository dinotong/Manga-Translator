/**
 * What language a reading set is in, decided from more than one page.
 *
 * ## The measurement this exists because of
 *
 * D-038 gave `auto` a real detector: the model returns `src` for every crop, so
 * the script can be read off a reply that was already paid for, remembered per
 * set, and a page processed under the wrong guess is re-read once. Measured on a
 * live imhentai gallery an hour after it shipped, that arrangement could not
 * settle:
 *
 *     35s  page reads as ja, not en — re-running this page
 *     85s  page reads as en, not ja — re-running this page
 *     89s  page reads as en, not ja — re-running this page
 *
 * The gallery was English lettering over artwork containing Japanese — product
 * packaging, signage, sound effects — so the script genuinely differs from page
 * to page, and sometimes within a page. Detection is per page; memory is per
 * set. A mixed set therefore had no fixed point: every page overwrote the
 * memory with its own answer, disagreed with the page before it, and bought a
 * whole extra request out of a 1,000-a-day budget to do it — on exactly the
 * pages the reader was waiting for.
 *
 * ## Why counting, rather than any of the narrower fixes
 *
 * "Refuse to flip back once settled" stops the oscillation but freezes whatever
 * page one happened to be, which on this gallery is a coin toss. "Weight by how
 * much text is in each script" is really a better *per-page* detector, and the
 * per-page answers were not wrong — the pages really were different. The
 * instability was never in the detection; it was in treating the newest page as
 * the whole truth about the set.
 *
 * So the memory holds evidence rather than a verdict, and two rules make a mixed
 * set converge by construction:
 *
 *   - **Hysteresis.** A challenger must lead the incumbent by `FLIP_MARGIN`
 *     pages to replace it. Strictly alternating scripts never open a gap of two,
 *     so the alternation above cannot move the working language at all — it
 *     settles on whichever script the set has more of, which is the best a
 *     single per-set value can do.
 *
 *   - **A hard cap on re-reads.** `MAX_REREADS_PER_SET` is the guarantee that
 *     does not depend on the counting being right: a wrong guess costs one extra
 *     page per gallery, ever. Once spent, a later flip still changes how the
 *     following pages are processed — it just stops buying a correction for
 *     pages already done. Getting the remaining pages right is worth a request;
 *     re-deciding the past is not.
 *
 * Both are needed. The margin alone would still allow one re-read per genuine
 * shift, and a set that drifts could pay repeatedly; the cap alone would leave
 * the working language flapping between pages, which changes the direction
 * rules and therefore the geometry, silently and for free.
 */

import type { LangCode } from '../types';

/**
 * How far a challenger must lead the incumbent before the set changes language.
 *
 * Two, because one is exactly what an alternating gallery produces. With a
 * margin of one, ja/en/ja/en flips on every page — which is the bug. Two
 * requires a real majority to have opened up and cannot be reached by
 * alternation at all, however long the gallery runs.
 */
export const FLIP_MARGIN = 2;

/**
 * Extra page reads a single set may ever spend on correcting itself.
 *
 * One. The re-read exists for one situation — the first page of a gallery was
 * processed under a guess that turned out wrong, and everything downstream of
 * detection was computed under the wrong direction rules. That is a one-time
 * correction, not a mechanism. Capping it here rather than trusting the counting
 * to converge means the worst case is bounded even if every assumption above is
 * wrong about some site nobody has tried yet.
 */
export const MAX_REREADS_PER_SET = 1;

/**
 * The evidence a set has accumulated. Persisted in `Settings.perSet`.
 *
 * Both fields spell `| undefined` out rather than relying on `?` alone, because
 * the project builds with `exactOptionalPropertyTypes` and these are read
 * straight off a stored record where absent and present-but-undefined are the
 * same thing to every caller.
 */
export interface LangEvidence {
  /** Pages that read as each script. */
  counts?: Partial<Record<LangCode, number>> | undefined;
  /** Re-reads already spent on this set. */
  rereads?: number | undefined;
}

export interface LangDecision {
  /** The evidence including this page, to persist. */
  counts: Partial<Record<LangCode, number>>;
  /** The language the set should be worked in from now on. */
  working: LangCode;
  /** Re-reads spent, including the one this decision may authorise. */
  rereads: number;
  /** Should this page be thrown away and read again under `working`? */
  reread: boolean;
}

/**
 * The language with the most pages, with ties going to the incumbent.
 *
 * Sorted by count and then by name so the answer never depends on the order
 * keys happen to sit in an object — a set restored from storage must decide the
 * same way as one built up in memory.
 */
function leader(counts: Partial<Record<LangCode, number>>): LangCode | null {
  const entries = (Object.entries(counts) as [LangCode, number][]).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0]?.[0] ?? null;
}

/**
 * Fold one page's detected script into what the set already knew.
 *
 * `incumbent` is the language the set was working in, or null on the first page
 * of a set that has never been decided — where the first real evidence wins
 * outright, because there is nothing yet for a margin to protect.
 *
 * `processedAs` is what this page was actually treated as, already resolved
 * through `resolveDetectionLang`, so that `auto` and a detected `ja` are
 * recognised as the same processing and do not buy a re-read that would produce
 * an identical result.
 */
export function observePage(
  evidence: LangEvidence | undefined,
  incumbent: LangCode | null,
  detected: LangCode,
  processedAs: LangCode,
): LangDecision {
  const counts: Partial<Record<LangCode, number>> = { ...evidence?.counts };
  counts[detected] = (counts[detected] ?? 0) + 1;

  const spent = Math.max(0, Math.floor(evidence?.rereads ?? 0));
  const front = leader(counts);

  let working: LangCode;
  if (incumbent === null) {
    working = front ?? detected;
  } else if (front === null || front === incumbent) {
    working = incumbent;
  } else {
    // The margin is measured against the incumbent specifically, not against
    // the runner-up: the question is whether to *move*, and an incumbent with
    // equal support is not something a tie should dislodge.
    const lead = (counts[front] ?? 0) - (counts[incumbent] ?? 0);
    working = lead >= FLIP_MARGIN ? front : incumbent;
  }

  // A re-read is only ever bought to fix *this* page. If the working language
  // already matches how the page was processed there is nothing to fix, however
  // much the evidence moved underneath.
  const reread = working !== processedAs && spent < MAX_REREADS_PER_SET;
  return { counts, working, rereads: spent + (reread ? 1 : 0), reread };
}
