/**
 * Predicting a later page's image URL.
 *
 * This only works where the reader's URLs are a plain counter — imhentai serves
 * `.../<dir>/<gallery>/3.webp` and the fourth page is the same URL with a 4 in
 * it. MangaDex builds its pages as `blob:` URLs inside its own JavaScript, so
 * there is nothing here that could predict them, and guessing would mean firing
 * requests at someone else's server for URLs that do not exist. When a site
 * cannot be predicted the honest answer is null and no prefetch happens.
 */

/**
 * Replace the trailing number of a URL's last path segment with `n + delta`.
 *
 * Zero padding is preserved (`007.webp` + 1 -> `008.webp`) because a CDN that
 * pads will 404 on an unpadded name. Returns null when the URL does not end in a
 * number, when the result would be below 1, or when the input is not a URL —
 * every one of which means "do not guess".
 */
export function bumpTrailingNumber(url: string, delta: number): string | null {
  if (!Number.isInteger(delta)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const match = parsed.pathname.match(/^(.*\/)(\d+)(\.[A-Za-z0-9]+)?$/);
  if (!match) return null;

  const [, dir, digits, ext = ''] = match as unknown as [string, string, string, string?];
  const next = Number(digits) + delta;
  if (!Number.isFinite(next) || next < 1) return null;

  const padded = digits.startsWith('0') ? String(next).padStart(digits.length, '0') : String(next);
  parsed.pathname = `${dir}${padded}${ext}`;
  return parsed.href;
}
