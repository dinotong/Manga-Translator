/**
 * When it is acceptable to speculatively translate a page nobody asked for.
 *
 * Prefetch is the one feature here that spends someone else's bandwidth on a
 * guess, so the rules are deliberately strict and kept in one pure function that
 * can be tested without a browser:
 *
 *   - at most one speculative request in flight, ever;
 *   - at least 500 ms between starts, so a run of cheap failures cannot turn
 *     into a burst;
 *   - nothing at all while the tab is hidden — a backgrounded reader is not
 *     reading, and continuing to pull pages then is indistinguishable from a
 *     crawler;
 *   - a bounded lookahead, so "read ahead a little" can never become "download
 *     the whole gallery". Pulling an entire chapter stays a thing the user asks
 *     for explicitly;
 *   - and two wrong guesses in a row end prefetching for that gallery. A URL
 *     pattern that does not hold is not going to start holding on page nine, so
 *     the cost of guessing wrong is capped at two requests rather than one per
 *     page for the rest of the book.
 *
 * What is deliberately *not* a rule any more: "wait until nothing is running".
 * That one sounded prudent and made the feature useless — a page takes about
 * three seconds, a reader turns the page in three to four, so a guess that may
 * only start once the visible page is finished never has time to finish before
 * it is needed.
 *
 * The invariant it was protecting — the visible page must never wait behind a
 * guess — is instead protected two ways here: `foregroundWaiting` refuses to add
 * a guess while real visible work is queued, and a foreground request for a page
 * already being fetched speculatively joins that job rather than starting a
 * second one (`adopt` in entrypoints/content.ts).
 *
 * What does *not* protect it, despite an earlier version of this comment saying
 * so: the service worker does not run speculative work in a separate lane. It
 * has one global queue (`enqueue` in entrypoints/background.ts) and a foreground
 * job that arrives while a guess is in flight waits behind it. Measured on
 * imhentai that costs nothing, because the guess in flight is almost always the
 * page the reader is turning to, but a reader who jumps somewhere unguessed can
 * wait one extra job. See D-027.
 *
 * ## Two ways to know what is coming, one set of rules
 *
 * Everything above is about *guessing* a later page's URL from the current one,
 * which only works where the site numbers its files. But a site does not have to
 * be guessable to be readable ahead: both long-strip readers the owner uses
 * mount a window of upcoming pages and put the real image URLs into their own
 * DOM before the reader gets there. Reading a URL the site has already published
 * is strictly better than deriving one — there is nothing to be wrong about, no
 * request goes to a URL that may not exist, and there is no per-site pattern to
 * keep working.
 *
 * So there are two ways to name the next page worth fetching — `nextPublished`
 * for sites that publish, `pickPrefetch` for sites that can be predicted — and
 * they share everything else. Same gate (`prefetchAllowed`), same covered set,
 * same one-at-a-time-per-batch, same silence while the tab is hidden. Neither is
 * a second rate knob.
 */

export const MIN_PREFETCH_GAP_MS = 500;

/**
 * The deepest lookahead the reader may ask for.
 *
 * Raised from 10 because "read the whole chapter ahead" is a thing the owner
 * actually wants, and 10 could not express it — the measured galleries run to 40
 * pages and chapters elsewhere run longer. There is still a ceiling, because an
 * unbounded value in storage would become an unbounded number of requests to
 * somebody else's server, and `pickPrefetch` already stops at the gallery's real
 * last page anyway, so the cap only ever binds on a book longer than this.
 *
 * Depth is not rate. Every politeness rule below is untouched by how deep this
 * goes: one speculative request in flight, a minimum gap between starts, nothing
 * while the tab is hidden. A deeper setting means the reader is read *further*
 * ahead over time, never that more is fired at once.
 */
export const MAX_LOOKAHEAD = 200;

/** What the Options page offers as "the whole chapter". */
export const LOOKAHEAD_WHOLE_CHAPTER = MAX_LOOKAHEAD;

/** Consecutive failed guesses in one gallery before giving up on it. */
export const MAX_CONSECUTIVE_MISSES = 2;

/** 0 disables prefetch entirely; anything outside 0..MAX_LOOKAHEAD is a mistake, not a wish. */
export function clampLookahead(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_LOOKAHEAD, Math.max(0, n));
}

/**
 * How far ahead we may actually read, given how much the cache will hold.
 *
 * These two settings can contradict each other, and the contradiction is
 * expensive and completely invisible: prefetching 40 pages into a cache that
 * holds 20 evicts the earliest guesses before the reader reaches them, so the
 * request, the free-tier quota and the GPU pass are all spent for nothing and
 * the reader still sees "กำลังอ่านภาพ…" on a page the extension already
 * finished.
 *
 * Resolving it here — against the depth the reader *chose* — rather than by
 * forcing a floor under the cache is what keeps both settings usable. Tying the
 * cache floor to `MAX_LOOKAHEAD` instead would mean that raising the ceiling so
 * "the whole chapter" could be expressed silently forbade every reader from
 * choosing a small cache, whether or not they prefetch at all.
 *
 * `- 1` because the page being read occupies a cache slot of its own.
 */
export function effectiveLookahead(configured: unknown, cachePages: number): number {
  const asked = clampLookahead(configured);
  if (!Number.isFinite(cachePages)) return asked;
  return Math.max(0, Math.min(asked, Math.floor(cachePages) - 1));
}

/**
 * Everything that decides *whether* a speculative request may start now.
 *
 * Deliberately says nothing about *which* page. Both ways of naming a page — a
 * URL the site published, or one derived from the current page's — answer to
 * exactly these rules, and splitting them out is what keeps that true rather
 * than merely intended.
 */
export interface PrefetchGate {
  now: number;
  /** Auto translate is on and the extension is enabled. */
  enabled: boolean;
  /** How many pages ahead the user allows. 0 turns the feature off. */
  lookahead: number;
  /** document.visibilityState === 'visible'. */
  visible: boolean;
  /**
   * A page the reader is actually looking at is waiting for a free slot.
   *
   * Not "a page is being worked on" — that is the normal state while reading and
   * blocking on it is what made prefetch pointless. This is the narrower case of
   * real visible work already queued up, where adding a guess to the pile helps
   * nobody.
   */
  foregroundWaiting: boolean;
  /** Speculative pages currently being worked on. */
  inFlight: number;
  /**
   * How many speculative pages may be in flight at once.
   *
   * This is *not* a second rate knob. It exists because crops from several pages
   * now ride in one Gemini request (see core/batch.ts), and a batch cannot form
   * if only one page is ever being prepared — the reason to allow a second and a
   * third is precisely so they leave together rather than separately. Requests
   * to the reader's own site are still spaced by MIN_PREFETCH_GAP_MS, and the
   * number of outbound Gemini requests goes *down*, not up.
   *
   * Defaults to 1, which is the behaviour this had before batching existed.
   */
  batchSize?: number;
  /** Guesses that came back as "no such image", in a row, in this gallery. */
  consecutiveMisses: number;
  /** Timestamp the last speculative request started, or 0. */
  lastStartAt: number;
}

export interface PrefetchInput extends PrefetchGate {
  /** Page the reader is on, or null when the site does not expose one. */
  currentPage: number | null;
  /** Last page of the gallery, or null when unknown. */
  totalPages: number | null;
  /** Pages already fetched, in flight, or known to be cached. */
  covered: ReadonlySet<number>;
}

/** May *any* speculative request start right now? */
export function prefetchAllowed(gate: PrefetchGate): boolean {
  if (!gate.enabled) return false;
  if (clampLookahead(gate.lookahead) === 0) return false;
  if (!gate.visible) return false;
  if (gate.consecutiveMisses >= MAX_CONSECUTIVE_MISSES) return false;
  if (gate.foregroundWaiting) return false;
  if (gate.inFlight >= Math.max(1, gate.batchSize ?? 1)) return false;
  if (gate.now - gate.lastStartAt < MIN_PREFETCH_GAP_MS) return false;
  return true;
}

/**
 * The next page worth fetching ahead of the reader, or null for "not now".
 *
 * Nearest first: page n+1 is the one about to be needed, and a lookahead of 3
 * that started with n+3 would leave the very next turn uncovered.
 */
export function pickPrefetch(input: PrefetchInput): number | null {
  if (!prefetchAllowed(input)) return null;
  if (input.currentPage === null || !Number.isFinite(input.currentPage)) return null;

  const lookahead = clampLookahead(input.lookahead);
  for (let ahead = 1; ahead <= lookahead; ahead++) {
    const page = input.currentPage + ahead;
    if (input.totalPages !== null && page > input.totalPages) break;
    if (!input.covered.has(page)) return page;
  }
  return null;
}

/**
 * A page whose real image URL the site has already put into its own DOM.
 *
 * Produced by a site profile, which is the only place that may know how a
 * particular reader numbers and mounts its pages. Everything downstream treats
 * these as plain facts.
 */
export interface PublishedPage {
  /** Absolute page number in the gallery, one-based. */
  page: number;
  /** The URL the site itself published for that page. */
  url: string;
  /** Top edge of the element, in px relative to the top of the viewport. */
  top: number;
}

export interface PublishedInput {
  /** Everything the page currently publishes, in any order. */
  pages: readonly PublishedPage[];
  viewportHeight: number;
  /** How many pages ahead the reader allows, as for `pickPrefetch`. */
  lookahead: number;
  /** Pages already fetched, in flight, or known to be cached. */
  covered: ReadonlySet<number>;
}

/**
 * The next published page worth fetching, or null.
 *
 * ## Why "ahead" is measured against the bottom of the viewport
 *
 * A page whose top edge is below the fold is one the reader has not reached, on
 * any reader, without needing to know which page they are "on" — which is the
 * one thing these sites are unreliable about. luscious does expose `?index=`,
 * but measured on 2026-08-16 it named row 3 while row 4 was the one under the
 * reader's eyes, so deriving "ahead" from it would be off by one page in the
 * direction that matters. The element positions come from the same DOM read as
 * the URLs, so they cannot disagree with each other.
 *
 * ## Why overlapping the IntersectionObserver is not a waste
 *
 * Some of what this returns is within the observer's two-screen reach and will
 * be queued as real work shortly. That is not a duplicated request: the content
 * script keys work in flight by URL, so the element's own job adopts the one
 * already running rather than starting a second (`adopt` in
 * entrypoints/content.ts). Fetching it early is simply earlier.
 *
 * The cases where it is *not* merely earlier are the ones this exists for: an
 * element the site has given a real `src` but the browser has not decoded yet
 * (luscious sets `loading="lazy"`, so the ordinary path sits in `pendingLoad`
 * waiting for the site to get round to it), and pages mounted beyond two
 * screens, which the observer has not looked at at all.
 */
export function nextPublished(input: PublishedInput): PublishedPage | null {
  const lookahead = clampLookahead(input.lookahead);
  if (lookahead === 0) return null;

  const ahead = input.pages
    .filter(
      (p) =>
        Number.isInteger(p.page) &&
        p.page >= 1 &&
        p.url !== '' &&
        Number.isFinite(p.top) &&
        p.top >= input.viewportHeight,
    )
    .sort((a, b) => a.page - b.page)
    .slice(0, lookahead);

  // Nearest first, for the same reason as `pickPrefetch`: the next turn is the
  // one about to be needed.
  return ahead.find((p) => !input.covered.has(p.page)) ?? null;
}
