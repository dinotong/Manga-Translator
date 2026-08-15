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
  /**
   * Is this URL a page being *read*, as opposed to a list of things to pick?
   *
   * Automatic translation is for the one page in front of the reader. On a
   * listing it spends quota on cover art and paints over the very covers being
   * browsed, which is the bug this answers. When a profile implements this its
   * answer is final in both directions — we know the site, there is nothing to
   * guess — and core/page-kind.ts only runs where no profile does.
   *
   * Right-click "แปลรูปนี้" ignores this entirely: that is the reader pointing
   * at one image on purpose, and it must keep working on a listing.
   */
  isReaderPage?(url: URL): boolean;
  /**
   * Concrete hostnames this profile is aimed at.
   *
   * `match()` is a pattern and cannot be enumerated, but the v2 -> v3 settings
   * migration needs an actual list of sites to switch auto-translate on for —
   * see shared/settings.ts. Kept here because hostnames are site knowledge, and
   * site knowledge does not belong in core/ or in shared/.
   */
  seedHosts?: readonly string[];
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
  seedHosts: ['mangadex.org'],
  pageSelector: '.md--page img.img, img.img',
  acquire: 'content-script',
  reader: 'auto',
  // Reading happens at /chapter/{uuid}[/{page}] and nowhere else. `/title/…`,
  // `/titles/latest` and the front page are all lists of covers — measured, the
  // front page carries a hero carousel that covers 86% of the window, which is
  // exactly the kind of thing a generic size rule would mistake for a page.
  isReaderPage: (u) => /^\/chapter\/[0-9a-f-]+/i.test(u.pathname),
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
  // The site is served under several TLDs and `match` deliberately covers all
  // of them. The upgrade cannot know which one the reader uses, and a site left
  // out goes silent with no explanation, so all the known ones are seeded; an
  // unused row is removable in one click on the options page.
  seedHosts: ['imhentai.xxx', 'imhentai.com', 'imhentai.net'],
  pageSelector: '#gimg',
  exclude: 'iframe *',
  acquire: 'sw-fetch',
  reader: 'paged',
  // The site carries both Japanese and English galleries, so a fixed source
  // language here would be wrong half the time.
  sourceLang: 'auto',
  // `/view/{id}/{n}/` is the reader. `/gallery/{id}/` is the *listing* for that
  // same gallery — the cover plus every page as a thumbnail — and the front
  // page and search results are listings too. This is worth stating explicitly
  // even though `#gimg` exists only in the reader, because the selector is a
  // fact about today's markup and this is a fact about the site.
  isReaderPage: (u) => /^\/view\/\d+\//.test(u.pathname),
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

/**
 * Every hostname a profile was written for.
 *
 * The only consumer is the v2 -> v3 migration: a reader who had the old global
 * auto-translate switch on keeps it on for the sites it was ever aimed at, and
 * gets it off everywhere else. Adding a profile later does not retroactively
 * switch anything on — the migration runs once.
 */
export const PROFILE_HOSTS: readonly string[] = REGISTRY.flatMap((p) => p.seedHosts ?? []);
