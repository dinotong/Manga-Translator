import { PASS_SCORE, scoreCandidate } from '../core/scoring';
import type { SiteProfile } from './site-profiles';

/**
 * Find the manga pages on this document.
 *
 * A site profile with a selector short-circuits everything — when we know the
 * answer there is no reason to guess. Otherwise the generic scorer runs, which
 * is what makes the extension useful on the hundredth site nobody wrote a
 * profile for.
 */

const CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);

export function scanImages(profile: SiteProfile): HTMLImageElement[] {
  const all = Array.from(document.images);
  const excluded = profile.exclude
    ? new Set(Array.from(document.querySelectorAll(profile.exclude)))
    : null;

  if (profile.pageSelector) {
    const wanted = new Set(Array.from(document.querySelectorAll(profile.pageSelector)));
    return all.filter((img) => wanted.has(img) && !excluded?.has(img) && isLoaded(img));
  }

  return all.filter((img) => {
    if (excluded?.has(img) || !isLoaded(img)) return false;
    return scoreCandidate(featuresOf(img)) >= PASS_SCORE;
  });
}

/** An image with no intrinsic size has not decoded yet; there is nothing to hash. */
export function isLoaded(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
}

function featuresOf(img: HTMLImageElement) {
  const rect = img.getBoundingClientRect();
  const ancestor = img.closest('[id],[class]');

  let inChrome = false;
  for (let el: Element | null = img; el; el = el.parentElement) {
    if (CHROME_TAGS.has(el.tagName)) {
      inChrome = true;
      break;
    }
  }

  const link = img.closest('a');
  const inExternalLink = Boolean(
    link?.href && new URL(link.href, location.href).hostname !== location.hostname,
  );

  return {
    natural: { w: img.naturalWidth, h: img.naturalHeight },
    rendered: { w: rect.width, h: rect.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    text: `${img.id} ${img.className} ${img.alt}`.toLowerCase(),
    ancestorText: `${ancestor?.id ?? ''} ${ancestor?.className ?? ''}`.toLowerCase(),
    inChrome,
    inExternalLink,
  };
}

/**
 * A stable per-tab identity for an element.
 *
 * Not used to key overlays — those key on the image hash, because imhentai
 * swaps src on one element and an element-keyed overlay would leave page 3's
 * translation sitting on top of page 4. This is only so a job result can find
 * the element it came from.
 */
const keys = new WeakMap<Element, string>();
let counter = 0;

export function elementKey(el: Element): string {
  let key = keys.get(el);
  if (!key) {
    key = `el${++counter}`;
    keys.set(el, key);
  }
  return key;
}
