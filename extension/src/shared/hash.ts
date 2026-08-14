/**
 * Content hashes.
 *
 * The image hash is taken from the bytes as fetched, never from decoded pixels.
 * That is cheaper (no decode), works on a tainted image, and — the reason it is
 * a rule rather than an optimisation — stays stable when the resolution preset
 * changes, so switching Fast/Balanced/Quality does not invalidate every cached
 * page. It also survives CDN URLs that are signed and expire, which a URL-keyed
 * cache would not.
 */

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 22 base64url chars ≈ 132 bits. Collisions are not a practical concern here. */
export async function imageHash(bytes: ArrayBuffer): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 22);
}

const encoder = new TextEncoder();

/** Keys the translation store. SHA-1 is plenty for a cache key and is smaller. */
export async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(text));
  return base64url(digest);
}
