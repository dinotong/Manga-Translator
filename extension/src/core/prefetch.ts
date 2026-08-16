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

export interface PrefetchInput {
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
  /** Page the reader is on, or null when the site does not expose one. */
  currentPage: number | null;
  /** Last page of the gallery, or null when unknown. */
  totalPages: number | null;
  /** Pages already fetched, in flight, or known to be cached. */
  covered: ReadonlySet<number>;
}

/**
 * The next page worth fetching ahead of the reader, or null for "not now".
 *
 * Nearest first: page n+1 is the one about to be needed, and a lookahead of 3
 * that started with n+3 would leave the very next turn uncovered.
 */
export function pickPrefetch(input: PrefetchInput): number | null {
  if (!input.enabled) return null;
  if (clampLookahead(input.lookahead) === 0) return null;
  if (!input.visible) return null;
  if (input.consecutiveMisses >= MAX_CONSECUTIVE_MISSES) return null;
  if (input.foregroundWaiting) return null;
  if (input.inFlight >= Math.max(1, input.batchSize ?? 1)) return null;
  if (input.now - input.lastStartAt < MIN_PREFETCH_GAP_MS) return null;
  if (input.currentPage === null || !Number.isFinite(input.currentPage)) return null;

  const lookahead = clampLookahead(input.lookahead);
  for (let ahead = 1; ahead <= lookahead; ahead++) {
    const page = input.currentPage + ahead;
    if (input.totalPages !== null && page > input.totalPages) break;
    if (!input.covered.has(page)) return page;
  }
  return null;
}
