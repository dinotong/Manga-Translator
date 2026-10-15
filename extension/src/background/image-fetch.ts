import { declaredTooLarge, MAX_IMAGE_BYTES, readCapped, TooLargeError } from '../core/body-cap';
import { deadline, IMAGE_FETCH_TIMEOUT_MS } from '../core/deadline';
import { fetchDecision, mayReach } from '../core/fetch-policy';
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
  signal: AbortSignal | undefined,
  pageUrl: string | undefined,
): Promise<{ bytes: ArrayBuffer; hash: string; type: string }> {
  // The URL comes from inside a web page, and this fetch has powers that page
  // lacks. core/fetch-policy.ts decides what it may reach and whether the
  // reader's cookies go along (D-047). `pageUrl` is the sender
  // URL Chrome reported for the content script, not anything the page said.
  const decision = fetchDecision(url, pageUrl);
  if (!decision.allowed) {
    throw new PipelineError('ACQUIRE_FAILED', `refusing to fetch ${short(url)}: ${decision.reason}`);
  }
  const pageHost = pageUrl ? safeHost(pageUrl) : undefined;

  // A cancelled job (page turned, tab closed) must stop downloading too: the
  // worker frees its queue slot only when the job returns.
  const limit = deadline(IMAGE_FETCH_TIMEOUT_MS, signal);
  let res: Response;
  let bytes: ArrayBuffer;
  try {
    // Redirects are not followed with the cookies: the first hop is the only
    // URL the policy saw. A redirect is retried the way a page <img> would be
    // fetched (no cookies), and its landing host is checked like the first.
    res = await fetch(url, {
      credentials: decision.credentials,
      cache: 'force-cache',
      redirect: 'manual',
      signal: limit.signal,
    });
    if (res.type === 'opaqueredirect') {
      res = await fetch(url, { credentials: 'omit', cache: 'force-cache', signal: limit.signal });
      const landed = safeHost(res.url);
      if (landed === undefined || !mayReach(landed, pageHost)) {
        await res.body?.cancel().catch(() => undefined);
        throw new PipelineError('ACQUIRE_FAILED', `refusing ${short(url)}: redirected to a private-network host`);
      }
    }
    if (!res.ok) {
      throw new PipelineError('ACQUIRE_FAILED', `HTTP ${res.status} for ${short(url)}`);
    }
    // Bounded both ways: by what the host declares, and by what it actually
    // sends (D-047).
    if (declaredTooLarge(res.headers.get('content-length'))) {
      await res.body?.cancel().catch(() => undefined);
      throw new TooLargeError(MAX_IMAGE_BYTES);
    }
    bytes = await readCapped(res.body);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    if (err instanceof TooLargeError) {
      throw new PipelineError('ACQUIRE_FAILED', `${err.message}: ${short(url)}`);
    }
    if (limit.expired()) {
      throw new PipelineError('ACQUIRE_FAILED', `no image from ${short(url)} in ${IMAGE_FETCH_TIMEOUT_MS / 1000} s`);
    }
    if (signal?.aborted) throw new PipelineError('CANCELLED', 'aborted');
    throw new PipelineError('ACQUIRE_FAILED', `fetch failed for ${short(url)}: ${String(err)}`);
  } finally {
    limit.clear();
  }

  if (bytes.byteLength === 0) {
    throw new PipelineError('ACQUIRE_FAILED', `empty body for ${short(url)}`);
  }

  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  if (!type.startsWith('image/') && !type.includes('octet-stream')) {
    log.warn(`unexpected content-type "${type}" for ${short(url)}`);
  }

  return { bytes, hash: await imageHash(bytes), type };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function short(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}...` : url;
}
