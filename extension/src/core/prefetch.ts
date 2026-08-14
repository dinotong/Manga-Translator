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
 *   - nothing while the page the reader is actually looking at is still being
 *     worked on, because the visible page must never queue behind a guess;
 *   - a bounded lookahead, so "read ahead a little" can never become "download
 *     the whole gallery". Pulling an entire chapter stays a thing the user asks
 *     for explicitly.
 */

export const MIN_PREFETCH_GAP_MS = 500;
export const MAX_LOOKAHEAD = 10;

/** 0 disables prefetch entirely; anything outside 0..10 is a mistake, not a wish. */
export function clampLookahead(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_LOOKAHEAD, Math.max(0, n));
}

export interface PrefetchInput {
  now: number;
  /** Auto translate is on and the extension is enabled. */
  enabled: boolean;
  /** How many pages ahead the user allows. 0 turns the feature off. */
  lookahead: number;
  /** document.visibilityState === 'visible'. */
  visible: boolean;
  /** No foreground job running or waiting. */
  idle: boolean;
  /** Speculative requests currently outstanding. */
  inFlight: number;
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
  if (!input.idle) return null;
  if (input.inFlight > 0) return null;
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
