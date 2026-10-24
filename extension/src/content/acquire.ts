import { declaredTooLarge, MAX_IMAGE_BYTES, readCapped, TooLargeError } from '../core/body-cap';
import { deadline, IMAGE_FETCH_TIMEOUT_MS } from '../core/deadline';
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
 * One exception to the second: a CDN that answers CORS but serves only when
 * the Referer is its own site. The worker cannot send that Referer, so a
 * profile routes it here with 'content-script' — see hitomi in site-profiles.
 *
 * All three were confirmed against the live sites, not inferred.
 */

export type Acquired =
  | { kind: 'bytes'; ref: ImageRef; natural: { w: number; h: number } }
  | { kind: 'url'; url: string; natural: { w: number; h: number } };

/**
 * `signal` is the job's: once it aborts, a download still in progress stops and
 * this rejects with CANCELLED, so the job gives its queue slot back instead of
 * waiting on the network for an answer nobody wants.
 */
export async function acquire(
  img: HTMLImageElement,
  profile: SiteProfile,
  signal?: AbortSignal,
): Promise<Acquired> {
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
      return { kind: 'bytes', ref: await readHere(url, img, signal), natural };
    } catch (err) {
      if (local) throw err; // no second path exists for blob:
      if (isCancelled(err)) throw err; // nobody wants the second path either
      // A same-origin guess that turned out to be wrong is not fatal — the
      // service worker can still fetch it.
      console.debug('[mt:acquire] page fetch failed, deferring to service worker', err);
    }
  }

  return { kind: 'url', url, natural };
}

async function readHere(url: string, img: HTMLImageElement, signal?: AbortSignal): Promise<ImageRef> {
  const limit = deadline(IMAGE_FETCH_TIMEOUT_MS, signal);
  try {
    // Cookies only to the page's own origin. A cross-origin CDN that is read
    // from here does so through CORS, and the usual answer is
    // `Access-Control-Allow-Origin: *` — which the browser refuses for a
    // credentialed request. The page's <img> sent none to it either (D-047).
    const res = await fetch(url, { credentials: 'same-origin', signal: limit.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} reading ${url.slice(0, 60)}`);
    if (declaredTooLarge(res.headers.get('content-length'))) {
      await res.body?.cancel().catch(() => undefined);
      throw new TooLargeError(MAX_IMAGE_BYTES);
    }

    // Same cap as the worker's: the bytes are base64'd into one message next.
    const bytes = await readCapped(res.body);
    if (bytes.byteLength === 0) throw new Error('empty image body');
    return await imageRef(bytes);
  } catch (err) {
    if (signal?.aborted && !limit.expired()) throw new PipelineError('CANCELLED', 'aborted');
    if (err instanceof TooLargeError) throw new PipelineError('ACQUIRE_FAILED', err.message);
    if (url.startsWith('blob:')) return readDecodedBlob(img, err);
    if (url.startsWith('data:')) {
      throw new PipelineError('ACQUIRE_FAILED', `could not read local image: ${String(err)}`);
    }
    if (err instanceof Error && /^(HTTP \d+|empty image body)/.test(err.message)) {
      throw new PipelineError('ACQUIRE_FAILED', err.message);
    }
    throw err;
  } finally {
    limit.clear();
  }
}

function isCancelled(err: unknown): boolean {
  return err instanceof PipelineError && err.code === 'CANCELLED';
}

async function readDecodedBlob(img: HTMLImageElement, fetchError: unknown): Promise<ImageRef> {
  let canvas: HTMLCanvasElement | undefined;
  try {
    if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
      throw new Error('image is not decoded');
    }

    canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('could not create a 2D canvas context');
    context.drawImage(img, 0, 0);

    const surface = canvas;
    const png = await new Promise<Blob>((resolve, reject) => {
      surface.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas PNG encoding failed'))),
        'image/png',
      );
    });
    return await imageRef(await png.arrayBuffer());
  } catch (err) {
    throw new PipelineError(
      'ACQUIRE_FAILED',
      `blob fetch failed (${String(fetchError)}); decoded-image fallback failed: ${String(err)}`,
    );
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

async function imageRef(bytes: ArrayBuffer): Promise<ImageRef> {
  return {
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
