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

/**
 * Is this element a manga page?
 *
 * Split out of scanImages because the answer is needed one element at a time,
 * from the `load` handler: an image that is still downloading has no natural
 * size, so the heuristic cannot score it and the only correct thing to do is ask
 * again once the bytes arrive.
 */
export function isPageCandidate(img: HTMLImageElement, profile: SiteProfile): boolean {
  if (profile.exclude && img.matches(profile.exclude)) return false;
  if (profile.pageSelector) return img.matches(profile.pageSelector);
  if (!isLoaded(img)) return false;
  return scoreCandidate(featuresOf(img)) >= PASS_SCORE;
}

/**
 * Find the manga pages on this document.
 *
 * `includeUnloaded` is what the observers use. MangaDex inserts its page
 * elements before the blob is ready, so a scan that insisted on a decoded image
 * found zero pages and — because nothing rescans when an existing element
 * finishes loading — never found them at all. Watching an element that is still
 * downloading and deciding later is the only version of this that works.
 */
export function scanImages(
  profile: SiteProfile,
  opts: { includeUnloaded?: boolean } = {},
): HTMLImageElement[] {
  return Array.from(document.images).filter((img) => {
    if (!opts.includeUnloaded && !isLoaded(img)) return false;
    if (!isLoaded(img) && !profile.pageSelector) {
      // No selector and no pixels: nothing to score yet. Keep it so the caller
      // can attach a load listener, and re-judge it then.
      return !profile.exclude || !img.matches(profile.exclude);
    }
    return isPageCandidate(img, profile);
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
