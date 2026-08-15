/**
 * Which sites auto-translate is allowed to run on.
 *
 * Auto-translate used to be one global boolean, which meant turning it on to
 * read one gallery armed it on every page in the browser — every news article
 * and every dashboard got scanned, and anything that looked enough like a manga
 * page spent a request from a 1,000/day budget nobody agreed to.
 *
 * The scope is the **hostname**, not the URL. A per-URL memory would forget on
 * the next page of the same gallery, which is worse than no memory at all: the
 * reader would re-enable it on every page turn. A hostname is also the smallest
 * unit the reader actually thinks in ("this site translates, that one does not").
 *
 * Nothing here touches the DOM, storage or chrome.* — it is the whole of the
 * "is this site on?" decision, so it can be tested without a browser.
 */

/**
 * Canonical form of a hostname.
 *
 * Lowercased, trailing root dot removed, and a leading `www.` dropped so that
 * `www.mangadex.org` and `mangadex.org` are one remembered site rather than two.
 * The `www.` strip is skipped when nothing with a dot would be left, so a real
 * host called `www.com` is not turned into `com`.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) {
    const rest = h.slice(4);
    if (rest.includes('.')) h = rest;
  }
  return h;
}

/**
 * The remembered key for a page, or null when there is nothing to remember.
 *
 * Only http(s) pages get a key. `chrome://`, `edge://`, `about:`, `file:` and
 * extension pages are not sites the reader can meaningfully switch on, and
 * giving them a key would put entries like `newtab` in the settings list.
 */
export function siteKey(url: string | URL): string | null {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = normalizeHost(u.hostname);
  return host === '' ? null : host;
}

/**
 * The gate.
 *
 * A site nobody has switched on is off — that is the default and there is no
 * third state. An absent entry and an explicit "off" are the same thing, which
 * is why the stored list only ever holds the sites that are on: it can be shown
 * to the reader as-is, and it cannot grow a tail of `false` entries for every
 * site they ever visited.
 */
export function isAutoOn(sites: readonly string[], key: string | null): boolean {
  return key !== null && sites.includes(key);
}

/** The list with `key` added or removed. Returns a new array; input untouched. */
export function withAutoSite(sites: readonly string[], key: string | null, on: boolean): string[] {
  if (key === null) return [...sites];
  const without = sites.filter((s) => s !== key);
  if (!on) return without;
  // Appended, not sorted: the options list then reads in the order the reader
  // turned sites on, which is the order they will recognise them in.
  return [...without, key];
}

/**
 * Clean a stored list on the way in.
 *
 * Applied on every read rather than only on write, for the same reason
 * `clampLookahead` is: this list decides what gets to spend the reader's quota,
 * and a hand-edited or half-migrated storage entry must not be able to smuggle
 * in `WWW.Example.COM ` as a third spelling of a site.
 */
export function normalizeSiteList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const host = normalizeHost(item);
    if (host !== '' && !out.includes(host)) out.push(host);
  }
  return out;
}
