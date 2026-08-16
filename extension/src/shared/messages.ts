import type { Direction, NormRect, Size } from '../types';
import type { ErrCode } from './errors';
import type { SourceLang, TargetLang } from './lang';

/**
 * The single source of truth for everything that crosses a context boundary.
 *
 * Four isolated worlds talk here — content script, service worker, offscreen
 * document, and the popup/options pages — and none of them can see each other's
 * code. A typed union is the only thing standing between us and a silent
 * mismatch that shows up as "nothing happens" on a real site.
 *
 * One hard constraint shapes the payloads: chrome.runtime messaging serialises
 * with a JSON-like algorithm, so an ArrayBuffer arrives as `{}`. Image bytes
 * therefore travel by reference (`ImageRef`) rather than inline wherever the
 * sender and receiver share an origin. See shared/blob-bridge.ts.
 */

export const PORT_NAME = 'manga-translator';

/** Where the pipeline is, for the overlay's status pill. */
export type Stage = 'acquire' | 'detect' | 'translate' | 'done';

/** One rendered bubble. Coordinates are normalized against the natural size. */
export interface OverlayBlock {
  rect: NormRect;
  /** Translated text — what gets drawn. */
  text: string;
  /** Recognized source text, for the hover-to-see-original display mode. */
  source: string;
  direction: Direction;
  /** True when the provider refused this specific block. */
  refused?: boolean;
}

/**
 * A handle to image bytes parked in extension-origin Cache Storage.
 *
 * `inlineBase64` is the fallback for when Cache Storage refuses the write. It is
 * the one place base64 crosses a boundary, and it is deliberate: the alternative
 * is losing the image entirely, and JSON serialisation gives us no transferables
 * to use instead.
 */
export interface ImageRef {
  hash: string;
  bytes: number;
  inlineBase64?: string;
}

export interface JobSource {
  /** Element identity within the tab, so the overlay can find it again. */
  elementKey: string;
  /** Resolved currentSrc. Null when only bytes are available (canvas capture). */
  url: string | null;
  /** Present when the content script could read the bytes itself. */
  image?: ImageRef;
  natural: Size;
  /** Page URL, needed as a Referer when the service worker refetches. */
  pageUrl: string;
  /** Gallery/series key, for per-set language memory. */
  setKey: string | null;
  /** Skip the cache and redo the work. Used by "translate again". */
  force?: boolean;
  /**
   * Speculative: nobody is looking at this page yet.
   *
   * The pipeline is identical — the point is to fill the cache — but the result
   * is never drawn, a failure is never shown to the user, and the content script
   * rate-limits these separately. See core/prefetch.ts.
   */
  prefetch?: boolean;
  /**
   * The reader asked for this one explicitly — right-click, or "translate this
   * page now".
   *
   * Carried all the way to the worker rather than inferred there, because it
   * changes three separate things: the job jumps the queue ahead of everything
   * automatic (core/scheduling.ts), it is sent in a request of its own rather
   * than batched with other pages (background/read-batcher.ts), and it always
   * forces past the cache. A click means "do it again", and the reader has no
   * way to know which internal state the previous attempt left behind.
   */
  manual?: boolean;
  /**
   * Pixels from the middle of the viewport when the job was queued.
   *
   * Only a tiebreak between jobs of the same kind, and only the content script
   * can measure it. Absent means "no opinion" — see `distanceOf` in
   * entrypoints/background.ts.
   */
  distance?: number;
  /**
   * The image was actually intersecting the viewport when the job was queued.
   *
   * The IntersectionObserver starts work two screens early, so most automatic
   * jobs are for pages the reader cannot see yet. Those two cases look identical
   * to the worker and are not: a page on screen has someone waiting for it and
   * must go out immediately, while a page still two screens away has about
   * twelve seconds of slack at a normal reading pace and can wait a moment to
   * share a request with its neighbours. Without this distinction batching never
   * fires at all on a site with no prefetch profile — measured, zero multi-page
   * requests across a four minute read.
   */
  onScreen?: boolean;
}

/* ---------- content script -> service worker (over a long-lived Port) ---------- */

export type ContentToSw =
  | { t: 'RUN'; jobId: string; source: JobSource }
  | { t: 'CANCEL'; jobId: string };

/* ---------- service worker -> content script (same Port) ---------- */

export type SwToContent =
  | { t: 'PROGRESS'; jobId: string; stage: Stage; detail?: string }
  | {
      t: 'RESULT';
      jobId: string;
      hash: string;
      natural: Size;
      blocks: OverlayBlock[];
      fromCache: boolean;
      warning: string | null;
    }
  | { t: 'ERROR'; jobId: string; code: ErrCode; message: string; hint: string };

/* ---------- one-shot request/response (sendMessage) ---------- */

export interface DiagnosticLine {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** What to do about it, in Thai. Empty when status is ok. */
  fix: string;
}

export interface CacheStats {
  ocrRecords: number;
  translationRecords: number;
  bytes: number;
}

export type Request =
  | { t: 'PING' }
  /** Sent when the toggle flips on: pays the WebGPU shader-compile cost up front. */
  | { t: 'PREWARM' }
  | { t: 'DIAGNOSE' }
  | { t: 'TEST_KEY'; apiKey: string; model: string }
  | { t: 'CACHE_STATS' }
  | { t: 'CACHE_CLEAR'; which: 'all' | 'ocr' | 'translation' }
  /** Popup asks the active tab to translate whatever is on screen. */
  | { t: 'TRANSLATE_VISIBLE'; tabId: number };

export type Response =
  | { ok: true; pong: true }
  | { ok: true; lines: DiagnosticLine[] }
  | { ok: true; stats: CacheStats }
  | { ok: true }
  | { ok: false; code: ErrCode; message: string; hint: string };

/* ---------- service worker -> content script (sendMessage) ---------- */

export type SwToTab =
  | { t: 'CONTEXT_TRANSLATE'; srcUrl: string | undefined }
  | { t: 'TRANSLATE_VISIBLE' }
  | { t: 'SETTINGS_CHANGED' };

/* ---------- service worker <-> offscreen document ---------- */

export interface DetectedBlock {
  /** Normalized against the natural image size, ready to cache or render. */
  rect: NormRect;
  direction: Direction;
  score: number;
  /** Crop of this block, parked in Cache Storage as image/webp. */
  cropRef: ImageRef;
}

export type SwToOffscreen =
  | { t: 'OFF_PREWARM'; runtime: 'auto' | 'webgpu' | 'wasm'; dilateRatio: number }
  | {
      t: 'OFF_DETECT';
      jobId: string;
      image: ImageRef;
      lang: SourceLang;
      preset: string;
      runtime: 'auto' | 'webgpu' | 'wasm';
      dilateRatio: number;
      rtl: boolean;
    }
  | { t: 'OFF_CAPS' };

export interface DetectResult {
  natural: Size;
  detSize: Size;
  blocks: DetectedBlock[];
  detectorId: string;
  backend: string;
  warning: string | null;
  ms: { decode: number; detect: number; group: number };
}

export interface Caps {
  webgpu: boolean;
  adapter: string;
  backend: string;
  modelBytes: number;
  ready: boolean;
}

export type OffscreenReply =
  | { ok: true; result: DetectResult }
  | { ok: true; caps: Caps }
  | { ok: true }
  | { ok: false; code: ErrCode; message: string; hint: string };

/** Used for the batch translate call so the pair stays typed end to end. */
export interface TranslateItem {
  id: string;
  src: string;
  out: string;
}

export interface LangPairOpts {
  from: SourceLang;
  to: TargetLang;
}
