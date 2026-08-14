import type { ImageRef } from './messages';

/**
 * Moving image bytes between the service worker and the offscreen document.
 *
 * chrome.runtime messaging serialises with a JSON-like algorithm — there are no
 * transferables and an ArrayBuffer arrives as `{}` — so a 2.5 MB MangaDex page
 * would have to be base64'd through the IPC channel twice. Instead the sender
 * parks the bytes in Cache Storage and passes a key. Both the service worker and
 * the offscreen document run on the same chrome-extension:// origin, so they see
 * the same cache, and the bytes never get copied through a string at all.
 *
 * Cache Storage rejects chrome-extension: request URLs, hence the .invalid
 * hostname: `put()` never performs a fetch, so the URL is only ever a key, and
 * .invalid is reserved by RFC 2606 precisely so it can never resolve.
 *
 * The base64 fallback exists because this is a storage API and storage APIs fail
 * — quota, incognito, an eviction mid-flight. Losing the page because the cache
 * said no would be a much worse trade than one string copy.
 */

const CACHE_NAME = 'mt-transfer';
const ORIGIN = 'https://manga-translator.invalid/blob/';

/** Beyond this we prefer to fail loudly rather than build a giant string. */
const MAX_INLINE_BYTES = 24 * 1024 * 1024;

export async function putBytes(hash: string, bytes: ArrayBuffer, type: string): Promise<ImageRef> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      new Request(ORIGIN + encodeURIComponent(hash)),
      new Response(bytes, { headers: { 'content-type': type } }),
    );
    return { hash, bytes: bytes.byteLength };
  } catch (err) {
    if (bytes.byteLength > MAX_INLINE_BYTES) throw err;
    console.warn('[blob-bridge] cache unavailable, falling back to inline', err);
    return { hash, bytes: bytes.byteLength, inlineBase64: bytesToBase64(bytes) };
  }
}

export async function takeBytes(ref: ImageRef): Promise<ArrayBuffer> {
  if (ref.inlineBase64 !== undefined) return base64ToBytes(ref.inlineBase64);

  const cache = await caches.open(CACHE_NAME);
  const key = ORIGIN + encodeURIComponent(ref.hash);
  const hit = await cache.match(key);
  if (!hit) throw new Error(`blob-bridge: nothing parked under ${ref.hash}`);
  return hit.arrayBuffer();
}

/** Drop a parked entry once it has been consumed. Best effort by design. */
export async function releaseBytes(ref: ImageRef): Promise<void> {
  if (ref.inlineBase64 !== undefined) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(ORIGIN + encodeURIComponent(ref.hash));
  } catch {
    /* an orphan here costs a few MB until the browser evicts it */
  }
}

/** Wipe anything left behind by a job that died mid-flight. */
export async function clearTransfers(): Promise<void> {
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
}

/**
 * Chunked because String.fromCharCode(...array) blows the argument limit
 * somewhere around 100k elements, and a manga page is far past that.
 */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}
