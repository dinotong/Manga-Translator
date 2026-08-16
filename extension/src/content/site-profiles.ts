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

/**
 * luscious.net — a long strip, and the site that proved the page-level gate
 * needed a distance rule (D-032).
 *
 * Everything below was read off the live reader through CDP on 2026-08-16, on
 * `members.luscious.net` (the host the owner's switch is actually set for) and
 * on `www.luscious.net`, which serve the same markup.
 *
 * The reader mounts a *window* of pages, not the whole album: measured, three
 * `.picture-row` elements at the top of an album, growing to five as the reader
 * scrolls, of which two or three have decoded and the rest already carry the
 * real `src`. So the pages just ahead of the reader are in the DOM, with their
 * true URLs, before they are needed — which is where the batcher's material
 * comes from here, without a single speculative request.
 *
 * What is *not* in the DOM is anything further ahead, and that is why there is
 * no `prefetch` block: the image URL is
 * `https://ah-img.luscious.net/syswift/<album>/<name>_p_01KGT1KM6FF7005SEG0RQA8HQA.1680x0.jpg`,
 * where the middle segment is a per-picture ULID. Nothing in it counts, so
 * nothing about page n tells us the URL of page n+1. The album's own GraphQL
 * endpoint knows, but asking it is an extra request to their server, which is
 * exactly what `prefetch.total` is forbidden to cost.
 */
const luscious: SiteProfile = {
  id: 'luscious',
  match: (u) => /(^|\.)luscious\.net$/.test(u.hostname),
  // `members.` and the bare host are separate keys to core/site-scope.ts —
  // only `www.` is folded away — and the owner reads on `members.`.
  seedHosts: ['luscious.net', 'members.luscious.net'],
  // Deliberately built from the two class names that are *not* CSS-module
  // hashes. The wrapper next to these reads
  // `picture_grid-module__pictureFrameWrapper--w_ApE`, which is regenerated on
  // every deploy; `.picture-row` and `<picture>` are hand-written and stable.
  //
  // Measured, this matches the 3 page rows and none of the other 15 images on
  // the reader — including the nine-image "you might also like" rail that made
  // every album look like a listing before D-032, and which sat 91,445 px below
  // the viewport when this was measured.
  pageSelector: '.picture-row picture img',
  // ah-img.luscious.net, cross-origin from every page host, no CORS header.
  acquire: 'sw-fetch',
  reader: 'strip',
  // Both Japanese and English albums, so a fixed source language is wrong about
  // half the time.
  sourceLang: 'auto',
  // `/albums/{slug}_{id}/read/` is the reader; `/albums/{slug}_{id}/` is that
  // album's own listing of thumbnails, and `/albums/list/…`, `/albums/new/…`,
  // `/hentai-manga/…` and the front page are all listings. Measured on the
  // album page: twelve images at 400 px or wider — thumbnails big enough to
  // score as pages, which is the trap this closes.
  isReaderPage: (u) => /^\/albums\/[^/]+\/read\/?$/.test(u.pathname),
  setKey: (u) => u.pathname.match(/^\/albums\/([^/]+)\/read\/?$/)?.[1] ?? null,
  // `?index=` is zero-based, and — measured over four scroll steps — the site
  // rewrites it as the strip moves, so it really does name the page in front of
  // the reader rather than the one they entered on. Reported one-based to match
  // every other site here. Nothing consumes it while `prefetch` is absent; it
  // is here because it is true and because the next person to ask "can this
  // site be read ahead?" should not have to measure it again.
  pageNumber: (u) => {
    const raw = u.searchParams.get('index');
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n + 1 : null;
  },
  notes: 'Long strip. Image URLs carry a per-picture ULID — unpredictable, so no prefetch.',
};

/**
 * e-hentai / exhentai — two readers on one site.
 *
 * MPV (`/mpv/{gid}/{token}/`) is the "read all" strip the owner uses. Measured
 * on the live page: it lays out one `div#image_{n}.mimg` placeholder per page —
 * 40 of them for a 40-page gallery, so the length of the book is free — and
 * keeps a sliding window of nine decoded `<img id="imgsrc_{n}">` inside them,
 * dropping the ones behind. Two of those nine are ahead of the reader, which is
 * what the batcher gets to work with here.
 *
 * `/s/{key}/{gid}-{page}` is the classic one-page-at-a-time reader, a single
 * `<img id="img">` inside `#i3`. Both are covered.
 *
 * No `prefetch`, and this one is worth being precise about because it looks so
 * close to possible. The image URL is a Hath node,
 * `https://<random>.<random>.hath.network:5515/h/<sha1>-<size>-<w>-<h>-wbp/keystamp=…;fileindex=…/3.webp`
 * — a different host per page, a per-file hash, a signed keystamp, and a
 * trailing number that is the *original filename*, not the page (page 5 of the
 * measured gallery ends in `1.webp`). `bumpTrailingNumber` would produce a
 * request to the wrong host for a file that does not exist.
 *
 * The page's own `window.imagelist` does hold real URLs — but measured, only
 * for the nine pages MPV has already loaded (`withI: 9` of 40), which are
 * exactly the pages that are already in the DOM as elements. Reading it would
 * add nothing, and filling it further means calling their API.
 */
const ehentai: SiteProfile = {
  id: 'e-hentai',
  match: (u) => /(^|\.)(e-hentai|exhentai)\.org$/.test(u.hostname),
  seedHosts: ['e-hentai.org', 'exhentai.org'],
  // Measured: 9 matches out of 61 images on MPV — the other 52 are the 25x20
  // per-page toolbar icons and site chrome — and 1 of 14 on `/s/`.
  pageSelector: '#pane_images img[id^="imgsrc_"], #i3 img',
  // hath.network, cross-origin from e-hentai.org.
  acquire: 'sw-fetch',
  // MPV is a strip, /s/ is paged.
  reader: 'auto',
  sourceLang: 'auto',
  // `/g/{gid}/{token}/` is the gallery listing, and the front page, `/tag/…`
  // and `/?f_search=` are listings too. Measured on `/g/`: zero images 400 px
  // or wider, because the thumbnails are CSS sprites rather than `<img>` — so
  // it was already quiet there, but this makes it a fact about the site rather
  // than a fact about their stylesheet.
  isReaderPage: (u) =>
    /^\/mpv\/\d+\/[0-9a-f]+/i.test(u.pathname) || /^\/s\/[0-9a-f]+\/\d+-\d+/i.test(u.pathname),
  setKey: (u) =>
    u.pathname.match(/^\/mpv\/(\d+)\//)?.[1] ??
    u.pathname.match(/^\/s\/[0-9a-f]+\/(\d+)-\d+/i)?.[1] ??
    null,
  // Only `/s/` gets a page number. MPV's URL ends in `#page1`, and it is
  // tempting to read that as the current page — but measured, scrolling 3,700 px
  // through the strip left the hash at `#page1`. It records the last thumbnail
  // the reader clicked, not where they are, and answering with it would be
  // answering with a stale number.
  pageNumber: (u) => {
    const n = u.pathname.match(/^\/s\/[0-9a-f]+\/\d+-(\d+)/i)?.[1];
    return n ? Number(n) : null;
  },
  notes:
    'MPV keeps ~9 decoded pages in the DOM. Image URLs are signed per-file Hath links — unpredictable, so no prefetch.',
};

/**
 * nhentai — the one of the three that *can* be read ahead.
 *
 * Measured on the live reader: `/g/{id}/{n}/` shows one image inside
 * `<section id="image-container">`, served as
 * `https://i{1..4}.nhentai.net/galleries/{media_id}/{n}.{ext}` where `{n}` is
 * the page number itself. That is the imhentai shape, so `bumpTrailingNumber`
 * applies unchanged, and the nav bar carries `<span class="num-pages">` so the
 * end of the book costs nothing to learn.
 *
 * Two things about the guess were checked rather than assumed:
 *
 *   - The host shard varies per page (pages 1,2,3,5 of one gallery came from
 *     i3, i2, i1, i3) but the shards mirror each other, so keeping the current
 *     page's host and changing only the number works: 24 of 24 in-range guesses
 *     loaded, across four galleries.
 *   - The extension is per gallery, not per site — older galleries are `.jpg`,
 *     newer ones `.webp` — and `bumpTrailingNumber` carries the current page's
 *     extension over, which is why that does not matter. A gallery that mixes
 *     the two within itself would cost at most the two misses that
 *     MAX_CONSECUTIVE_MISSES allows before prefetch gives up on it; none of the
 *     four sampled did.
 *
 * The only failures in that sweep were pages past the end of the book, which
 * `pickPrefetch` never asks for once `total()` answers.
 */
const nhentai: SiteProfile = {
  id: 'nhentai',
  match: (u) => /(^|\.)nhentai\.net$/.test(u.hostname),
  seedHosts: ['nhentai.net'],
  pageSelector: '#image-container img',
  // i{n}.nhentai.net, cross-origin from nhentai.net.
  acquire: 'sw-fetch',
  reader: 'paged',
  sourceLang: 'auto',
  // `/g/{id}/{n}/` is the reader; `/g/{id}/` is the cover-and-thumbnails
  // listing for the same gallery — measured, 21 images at 400 px or wider on
  // it, every one of them a thumbnail — and `/`, `/search/`, `/tag/…` and
  // `/random/` are listings too.
  isReaderPage: (u) => /^\/g\/\d+\/\d+\/?$/.test(u.pathname),
  setKey: (u) => u.pathname.match(/^\/g\/(\d+)\//)?.[1] ?? null,
  pageNumber: (u) => {
    const n = u.pathname.match(/^\/g\/\d+\/(\d+)/)?.[1];
    return n ? Number(n) : null;
  },
  prefetch: {
    // The reader's own "n of N" counter, already rendered. Reading it is a DOM
    // lookup, not a request — the rule this field exists under.
    total: (doc) => {
      const raw = doc.querySelector('.num-pages')?.textContent?.trim();
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

const REGISTRY: readonly SiteProfile[] = [mangadex, imhentai, luscious, ehentai, nhentai];

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
