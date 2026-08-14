import { bytesToBase64 } from '../shared/blob-bridge';
import { PipelineError } from '../shared/errors';
import { imageHash } from '../shared/hash';
import type { ImageRef } from '../shared/messages';
import type { SiteProfile } from './site-profiles';

/**
 * The page-side half of image acquisition.
 *
 * Two paths, equally important, and the mistake would be treating either as the
 * fallback:
 *
 *   blob: / data: / same-origin  ->  only the page can read these. A blob URL is
 *     scoped to the origin that created it, so a service worker fetch of one
 *     fails unconditionally. MangaDex is entirely this case.
 *
 *   cross-origin CDN            ->  only the extension can read these. The
 *     canvas is tainted and a page-context fetch is CORS-blocked; the service
 *     worker's host_permissions are the only way through. imhentai is entirely
 *     this case.
 *
 * Both were confirmed against the live sites, not inferred.
 */

export type Acquired =
  | { kind: 'bytes'; ref: ImageRef; natural: { w: number; h: number } }
  | { kind: 'url'; url: string; natural: { w: number; h: number } };

export async function acquire(img: HTMLImageElement, profile: SiteProfile): Promise<Acquired> {
  // currentSrc, not src: it accounts for srcset and <picture>, and readers use
  // both to serve a different file than the markup suggests.
  const url = img.currentSrc || img.src;
  const natural = { w: img.naturalWidth, h: img.naturalHeight };

  if (!url) throw new PipelineError('ACQUIRE_FAILED', 'image has no resolvable source');

  const local = url.startsWith('blob:') || url.startsWith('data:');
  const sameOrigin = !local && isSameOrigin(url);

  if (profile.acquire === 'sw-fetch' && !local) {
    return { kind: 'url', url, natural };
  }

  if (local || sameOrigin || profile.acquire === 'content-script') {
    try {
      return { kind: 'bytes', ref: await readHere(url), natural };
    } catch (err) {
      if (local) throw err; // no second path exists for blob:
      // A same-origin guess that turned out to be wrong is not fatal — the
      // service worker can still fetch it.
      console.debug('[mt:acquire] page fetch failed, deferring to service worker', err);
    }
  }

  return { kind: 'url', url, natural };
}

async function readHere(url: string): Promise<ImageRef> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new PipelineError('ACQUIRE_FAILED', `HTTP ${res.status} reading ${url.slice(0, 60)}`);

  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new PipelineError('ACQUIRE_FAILED', 'empty image body');

  return {
    // Hashed from the bytes as delivered, before any resizing, so the cache key
    // does not change when the resolution preset does.
    hash: await imageHash(bytes),
    bytes: bytes.byteLength,
    // The one base64 hop in the system. Chrome's extension messaging serialises
    // as JSON with no transferables, so an ArrayBuffer sent from a content
    // script arrives as `{}`; and the content script cannot reach the
    // extension-origin Cache Storage that the worker and offscreen document use
    // to hand bytes to each other. The service worker unpacks this once and the
    // rest of the pipeline moves bytes by reference.
    inlineBase64: bytesToBase64(bytes),
  };
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
