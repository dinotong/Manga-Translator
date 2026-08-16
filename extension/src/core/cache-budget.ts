import { MAX_LOOKAHEAD } from './prefetch';

/**
 * How much reading the cache keeps, and which records go when it is full.
 *
 * Two limits, deliberately not one:
 *
 *   - **pages** is the control the reader gets, because it is the unit they
 *     think in. "Does a chapter fit?" has an answer in pages and no answer at
 *     all in megabytes;
 *   - **bytes** is the guard underneath, because a page count says nothing
 *     about disk. Today a page costs about 4 KB (an OCR record holds text and
 *     rectangles, never the image), but that is a measurement of the current
 *     record shape, not a promise about the next one. The ceiling is what
 *     stops an unexpected record shape from turning a page count into an
 *     unbounded footprint.
 *
 * Both are honoured on every eviction pass: whichever binds first wins.
 *
 * ### Why the page floor is what it is
 *
 * Prefetch translates up to `MAX_LOOKAHEAD` pages ahead of the reader. A cache
 * that holds fewer pages than that evicts the earliest guess before the reader
 * ever arrives at it, so the request, the quota and the GPU pass are all spent
 * for nothing — and the reader sees "กำลังอ่านภาพ…" on a page the extension
 * already finished. Refusing to go below `MAX_LOOKAHEAD + 1` makes that
 * contradiction impossible to configure rather than merely unlikely, which is
 * why the floor lives here instead of in a warning nobody reads.
 *
 * ### Why the arithmetic is here and not in cache/stores.ts
 *
 * "Drop the oldest until two limits are both satisfied, across two stores with
 * different eviction rules" is easy to get subtly wrong and extremely
 * unpleasant to debug against a live IndexedDB in a service worker that is
 * being torn down every few seconds.
 */

/** A page costs this much, measured on a real 13-bubble Japanese page. */
export const BYTES_PER_PAGE_ESTIMATE = 4096;

/**
 * Never fewer pages than prefetch reads ahead, plus the page being read.
 * See the note above: below this the two settings actively fight each other.
 */
export const MIN_CACHE_PAGES = MAX_LOOKAHEAD + 1;

/**
 * Long enough for any gallery the target sites serve. At the measured record
 * size this whole cap is about 8 MB, so "keep everything" is genuinely cheap —
 * the expensive resource here was never disk, it was API requests.
 */
export const MAX_CACHE_PAGES = 2000;

export const MIN_CACHE_BYTES = 20 * 1024 * 1024;
export const MAX_CACHE_BYTES = 2000 * 1024 * 1024;

/**
 * 200 pages: more than a whole chapter on MangaDex (20–45) and more than most
 * imhentai galleries, so the default reader never meets eviction at all, and
 * costs under a megabyte of disk to promise.
 */
export const DEFAULT_CACHE_PAGES = 200;

/** Unchanged from the fixed budget this setting replaced. */
export const DEFAULT_CACHE_BYTES = 200 * 1024 * 1024;

export interface CacheLimits {
  /** Pages of OCR kept. The reader's control. */
  maxPages: number;
  /** Total bytes across both stores. The guard underneath. */
  maxBytes: number;
}

/** Clamped on read as well as on write, so a hand-edited storage entry cannot raise it. */
export function clampCachePages(value: unknown): number {
  // Absent or unparseable falls back to the default rather than to a limit: a
  // value that never arrived is not a request for the smallest cache the system
  // allows, and it is certainly not a request for the largest. A reader who
  // does type 0 gets the floor, because that is them asking for "as little as
  // possible".
  if (value == null) return DEFAULT_CACHE_PAGES;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CACHE_PAGES;
  return Math.min(MAX_CACHE_PAGES, Math.max(MIN_CACHE_PAGES, n));
}

export function clampCacheBytes(value: unknown): number {
  if (value == null) return DEFAULT_CACHE_BYTES;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CACHE_BYTES;
  return Math.min(MAX_CACHE_BYTES, Math.max(MIN_CACHE_BYTES, n));
}

export function normalizeCacheLimits(stored: unknown): CacheLimits {
  const s = stored as Partial<CacheLimits> | null | undefined;
  return {
    maxPages: clampCachePages(s?.maxPages ?? DEFAULT_CACHE_PAGES),
    maxBytes: clampCacheBytes(s?.maxBytes ?? DEFAULT_CACHE_BYTES),
  };
}

/** Roughly what a page budget costs on disk, for showing both units side by side. */
export function estimateBytesForPages(pages: number): number {
  return clampCachePages(pages) * BYTES_PER_PAGE_ESTIMATE;
}

/** Just enough of a stored record to decide its fate. */
export interface CacheEntry {
  key: string;
  bytes: number;
  lastAccessedAt: number;
}

export interface EvictionPlan {
  /** OCR keys to delete, oldest-accessed first. */
  ocr: string[];
  /** Translation keys to delete. Empty unless the byte ceiling still binds. */
  translation: string[];
  /** Pages left afterwards. */
  pages: number;
  /** Total bytes left afterwards, both stores. */
  bytes: number;
}

/**
 * Oldest-accessed first, with the key as a tie-break.
 *
 * The tie-break is not cosmetic: several records written in the same
 * millisecond is the normal case for a prefetched batch, and without it the
 * plan would depend on IndexedDB's cursor order, which is not something to
 * write tests against.
 */
function oldestFirst(entries: readonly CacheEntry[]): CacheEntry[] {
  return [...entries].sort(
    (a, b) => a.lastAccessedAt - b.lastAccessedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * What to delete to get back inside both limits. LRU, in three passes.
 *
 * 1. Pages: drop the oldest readings until the page count fits. This is the
 *    limit that normally binds, and it is the one the reader chose.
 * 2. Bytes, from the OCR store: readings are the bulky half and the half that
 *    can be recomputed from an image the reader still has open.
 * 3. Bytes, from the translation store — and only once step 2 has run out of
 *    OCR records to give.
 *
 * Step 3 exists because the translation store has no page limit of its own and
 * grows for as long as the extension is installed. Without it, a cache pushed
 * over the ceiling by translations alone would delete every single reading it
 * had — the expensive half — and still be over, on every page, forever.
 * Reaching it at all should be rare; translation records are a few hundred
 * bytes and pay off across a whole series, which is why they are last.
 */
export function planEviction(
  ocrEntries: readonly CacheEntry[],
  translationEntries: readonly CacheEntry[],
  limits: CacheLimits,
): EvictionPlan {
  const { maxPages, maxBytes } = normalizeCacheLimits(limits);
  const ocr = oldestFirst(ocrEntries);
  const translation = oldestFirst(translationEntries);

  let pages = ocr.length;
  let bytes = sum(ocr) + sum(translation);
  const dropOcr: string[] = [];
  const dropTranslation: string[] = [];

  let i = 0;
  while (i < ocr.length && (pages > maxPages || bytes > maxBytes)) {
    const rec = ocr[i++];
    if (!rec) break;
    dropOcr.push(rec.key);
    pages--;
    bytes -= rec.bytes;
  }

  let j = 0;
  while (j < translation.length && bytes > maxBytes) {
    const rec = translation[j++];
    if (!rec) break;
    dropTranslation.push(rec.key);
    bytes -= rec.bytes;
  }

  return { ocr: dropOcr, translation: dropTranslation, pages, bytes };
}

function sum(entries: readonly CacheEntry[]): number {
  let total = 0;
  for (const e of entries) total += e.bytes;
  return total;
}
