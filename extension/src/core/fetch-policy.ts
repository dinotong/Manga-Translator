/**
 * Which image URLs the service worker may fetch for a page, and with what.
 *
 * The worker fetches with the extension's host permissions, so it can do two
 * things the page that chose the URL cannot (D-047):
 *
 *   - carry the reader's cookies to another site, SameSite=Lax included, and
 *   - reach loopback and the local network from a public page.
 *
 * Both are refused here unless the page itself is in the same position: an
 * image on the page's own site gets the cookies (logged-in readers serve their
 * images from their own subdomains), and a private-network image is fetched
 * only for a page that is itself on a private network (a self-hosted reader on
 * the LAN). Everything else is fetched like a page `<img>` would be: no
 * cookies, public hosts only.
 *
 * Decided from the hostname alone. A public name that resolves to a private
 * address (DNS rebinding) is not visible from an extension and is not covered.
 *
 * Pure: no fetch, no DOM, so it is tested without a browser.
 */

export type FetchDecision =
  | { allowed: true; credentials: 'include' | 'omit' }
  | { allowed: false; reason: string };

export function fetchDecision(imageUrl: string, pageUrl: string | undefined): FetchDecision {
  const image = parse(imageUrl);
  if (!image || (image.protocol !== 'http:' && image.protocol !== 'https:')) {
    return { allowed: false, reason: 'not http(s)' };
  }
  const page = pageUrl ? parse(pageUrl) : null;
  if (!mayReach(image.hostname, page?.hostname)) {
    return { allowed: false, reason: 'private-network host for a public page' };
  }
  const sameSite = page !== null && siteOf(image.hostname) === siteOf(page.hostname);
  return { allowed: true, credentials: sameSite ? 'include' : 'omit' };
}

/** May a fetch for this page land on this host (also checked after redirects)? */
export function mayReach(host: string, pageHost: string | undefined): boolean {
  return !isPrivateHost(host) || (pageHost !== undefined && isPrivateHost(pageHost));
}

/**
 * Loopback, private, link-local, CGNAT and unspecified addresses, plus the
 * names that only ever mean "this machine" or "this network".
 *
 * Takes `URL.hostname`, which the URL parser has already normalised: decimal
 * or hex IPv4 forms become dotted quads, and IPv6 keeps its brackets.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) return isPrivateV6(host.slice(1, -1));
  const v4 = parseV4(host);
  if (v4) return isPrivateV4(v4);
  return (
    host === 'localhost' ||
    PRIVATE_SUFFIXES.some((s) => host.endsWith(s))
  );
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

function parseV4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const n = parts.map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

function isPrivateV4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateV6(addr: string): boolean {
  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped (::ffff:7f00:1 as the URL parser writes ::ffff:127.0.0.1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mapped) {
    const hi = parseInt(mapped[1] ?? '0', 16);
    const lo = parseInt(mapped[2] ?? '0', 16);
    return isPrivateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  const first = parseInt(addr.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // ULA, link-local
}

/**
 * The registrable domain, approximately: the last two labels, or three under
 * the common two-level public suffixes (`co.jp`, `co.uk`, `com.au`, ...).
 *
 * Approximate on purpose — the full Public Suffix List is ~250 KB. Erring
 * means treating two sites under an unlisted two-level suffix as one, which
 * only matters for whether cookies go along, and cookies are still scoped by
 * the browser to the domain that set them.
 */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || parseV4(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  const take = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'go', 'or', 'ne', 'gov', 'edu', 'in', 'mi']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
