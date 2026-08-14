import { bumpTrailingNumber } from '../core/page-url';
import type { SourceLang } from '../shared/lang';

/**
 * Per-site knowledge, isolated from everything else.
 *
 * The rule this file exists to enforce: no CSS selector for any one site may
 * appear in core/, in the scanner, or in the overlay. Adding a site should be
 * adding an object here, and if it ever requires touching the pipeline, the
 * abstraction was wrong.
 */
export interface SiteProfile {
  id: string;
  match(url: URL): boolean;
  /** When present, heuristic scoring is skipped entirely. */
  pageSelector?: string;
  /** Elements matching this are never candidates (ad iframes, thumbnails). */
  exclude?: string;
  /**
   * 'content-script' when the bytes are only reachable from the page (blob:),
   * 'sw-fetch' when the canvas is tainted and the page's own fetch is CORS
   * blocked. Both are first-class; 'auto' decides per element.
   */
  acquire: 'auto' | 'content-script' | 'sw-fetch';
  reader: 'paged' | 'strip' | 'auto';
  sourceLang?: SourceLang;
  /** Identifies the gallery/series, for per-set language memory and context. */
  setKey?(url: URL): string | null;
  /** Current page number, used to notice a page turn from the URL alone. */
  pageNumber?(url: URL): number | null;
  navSelectors?: { next?: string; prev?: string };
  /**
   * Present only where a later page's image URL can be derived without asking
   * the site for anything.
   *
   * Absent is the default and the safe answer: without it the extension never
   * sends a speculative request to that host. See core/prefetch.ts for the rate
   * rules that apply once it is present.
   */
  prefetch?: {
    /** Last page of the gallery, read from the page itself. Null when unknown. */
    total(doc: Document): number | null;
    /** URL of the image `ahead` pages on from `currentSrc`, or null to give up. */
    imageUrl(currentSrc: string, ahead: number): string | null;
  };
  notes?: string;
}

/**
 * MangaDex.
 *
 * Measured on the real site: `img.currentSrc` is a `blob:` URL, which is bound
 * to the page's origin and is completely invisible to a service worker fetch —
 * so this site *must* go through the content script. The upside of the same
 * origin is that the canvas is not tainted either.
 *
 * It also renders with `object-fit: contain` into a much smaller box than the
 * 3496x4960 source, which is why the overlay computes a content box instead of
 * trusting getBoundingClientRect.
 */
const mangadex: SiteProfile = {
  id: 'mangadex',
  match: (u) => /(^|\.)mangadex\.org$/.test(u.hostname),
  pageSelector: '.md--page img.img, img.img',
  acquire: 'content-script',
  reader: 'auto',
  setKey: (u) => u.pathname.match(/\/chapter\/([0-9a-f-]+)/i)?.[1] ?? null,
  pageNumber: (u) => {
    const n = u.pathname.match(/\/chapter\/[0-9a-f-]+\/(\d+)/i)?.[1];
    return n ? Number(n) : null;
  },
  // No `prefetch`: the reader builds each page as a blob: URL inside its own
  // JavaScript, so the next page's URL does not exist until MangaDex creates it.
  // Anything we invented here would be a request to their servers for a URL we
  // made up. The site preloads pages itself, and the scanner already picks up
  // those zero-sized preload slots, which gets the same result honestly.
  notes: 'blob: URLs — service worker fetch cannot see them. Paged by default, long strip optional.',
};

/**
 * imhentai — the opposite case, and the reason both acquisition paths exist.
 *
 * Images come from a cross-origin CDN with no CORS header, so the canvas is
 * tainted and a page-context fetch is blocked; only the extension's
 * host_permissions get past that. And the whole gallery is one `<img id="gimg">`
 * whose src is swapped on every page turn, which is where the "bind overlays to
 * the image hash, never to the element" rule comes from.
 */
const imhentai: SiteProfile = {
  id: 'imhentai',
  match: (u) => /(^|\.)imhentai\./.test(u.hostname),
  pageSelector: '#gimg',
  exclude: 'iframe *',
  acquire: 'sw-fetch',
  reader: 'paged',
  // The site carries both Japanese and English galleries, so a fixed source
  // language here would be wrong half the time.
  sourceLang: 'auto',
  setKey: (u) => u.pathname.match(/^\/view\/(\d+)\//)?.[1] ?? null,
  pageNumber: (u) => {
    const n = u.pathname.match(/^\/view\/\d+\/(\d+)/)?.[1];
    return n ? Number(n) : null;
  },
  navSelectors: { next: 'a.next_img, a.nav_next', prev: 'a.nav_prev' },
  // Measured on the live site: the image is `<cdn>/<dir>/<gallery>/<n>.webp` and
  // the page carries `<input id="pages">` with the gallery length, so both the
  // next URL and the end of the book are knowable without a single extra
  // request. That is the whole precondition for prefetching here.
  prefetch: {
    total: (doc) => {
      const raw = (doc.querySelector('#pages') as HTMLInputElement | null)?.value;
      const n = raw ? Number(raw) : Number.NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    imageUrl: (currentSrc, ahead) => bumpTrailingNumber(currentSrc, ahead),
  },
};

/** Anything else: heuristic scoring in scan.ts decides what is a manga page. */
export const DEFAULT_PROFILE: SiteProfile = {
  id: 'default',
  match: () => true,
  acquire: 'auto',
  reader: 'auto',
};

const REGISTRY: readonly SiteProfile[] = [mangadex, imhentai];

export function profileFor(url: URL): SiteProfile {
  return REGISTRY.find((p) => p.match(url)) ?? DEFAULT_PROFILE;
}
