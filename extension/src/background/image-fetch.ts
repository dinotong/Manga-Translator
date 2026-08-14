import { PipelineError } from '../shared/errors';
import { imageHash } from '../shared/hash';
import { makeLog } from '../shared/log';

const log = makeLog('fetch');

/**
 * The cross-origin half of image acquisition.
 *
 * A manga CDN almost never sends Access-Control-Allow-Origin, so drawing the
 * <img> into a canvas taints it and reading a single pixel throws — and a
 * page-context fetch of the same URL is blocked outright. The extension's
 * host_permissions exempt this fetch from CORS entirely, which is the only
 * reason imhentai works at all.
 *
 * It is not the universal path, though: MangaDex serves blob: URLs, which are
 * bound to the page's origin and are invisible here. That case is handled in the
 * content script, and both are first-class — see content/acquire.ts.
 */
export async function fetchImage(
  url: string,
): Promise<{ bytes: ArrayBuffer; hash: string; type: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      // Some readers gate images behind a login cookie.
      credentials: 'include',
      cache: 'force-cache',
    });
  } catch (err) {
    throw new PipelineError('ACQUIRE_FAILED', `fetch failed for ${short(url)}: ${String(err)}`);
  }

  if (!res.ok) {
    throw new PipelineError('ACQUIRE_FAILED', `HTTP ${res.status} for ${short(url)}`);
  }

  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new PipelineError('ACQUIRE_FAILED', `empty body for ${short(url)}`);
  }

  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  if (!type.startsWith('image/') && !type.includes('octet-stream')) {
    log.warn(`unexpected content-type "${type}" for ${short(url)}`);
  }

  return { bytes, hash: await imageHash(bytes), type };
}

function short(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}...` : url;
}
