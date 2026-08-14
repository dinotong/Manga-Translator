import { makeLog } from '../shared/log';
import { PipelineError } from '../shared/errors';

const log = makeLog('models');

/**
 * Model weights live in Cache Storage, downloaded on first use.
 *
 * They are not bundled into the .crx for two reasons. Chrome Web Store review
 * gets unhappy about large opaque binaries, and more practically the friends
 * this gets handed to would download the weights on every version bump even
 * though the weights never change. Weights are data, not remote code, so
 * fetching them at runtime is within MV3's rules.
 *
 * The URL is stored alongside the id so swapping in PP-OCRv5 later is one line
 * plus a version bump on the detector id (which is part of the cache key, so
 * stale OCR results invalidate themselves).
 */

export interface ModelSpec {
  id: string;
  url: string;
  /** Exact size. A truncated download shows up as "invalid protobuf" at load. */
  bytes: number;
  license: string;
}

export const PPOCR_DET: ModelSpec = {
  id: 'ppocr-v4-det',
  url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
  bytes: 4_745_517,
  license: 'Apache-2.0',
};

const CACHE_NAME = 'mt-models';

function keyFor(spec: ModelSpec): string {
  return `https://manga-translator.invalid/models/${spec.id}.onnx`;
}

/** How many bytes of this model are already on disk. 0 = not downloaded. */
export async function modelSize(spec: ModelSpec): Promise<number> {
  try {
    const hit = await (await caches.open(CACHE_NAME)).match(keyFor(spec));
    if (!hit) return 0;
    return (await hit.arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

export async function loadModel(
  spec: ModelSpec,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  const cached = await cache?.match(keyFor(spec));

  if (cached) {
    const buf = await cached.arrayBuffer();
    if (buf.byteLength === spec.bytes) {
      onProgress?.(1);
      return new Uint8Array(buf);
    }
    log.warn(`cached ${spec.id} is ${buf.byteLength} bytes, expected ${spec.bytes} — refetching`);
    await cache?.delete(keyFor(spec));
  }

  log.info(`downloading ${spec.id} (${(spec.bytes / 1e6).toFixed(1)} MB, ${spec.license})`);

  let res: Response;
  try {
    res = await fetch(spec.url, { redirect: 'follow' });
  } catch (err) {
    throw new PipelineError('MODEL_LOAD_FAILED', `fetch failed for ${spec.id}: ${String(err)}`);
  }
  if (!res.ok) {
    throw new PipelineError('MODEL_LOAD_FAILED', `HTTP ${res.status} downloading ${spec.id}`);
  }

  const bytes = await readWithProgress(res, spec.bytes, onProgress);
  if (bytes.byteLength !== spec.bytes) {
    throw new PipelineError(
      'MODEL_LOAD_FAILED',
      `${spec.id}: got ${bytes.byteLength} bytes, expected ${spec.bytes}`,
    );
  }

  // A fresh Response rather than the fetched one: Cache Storage refuses to
  // store a redirected response, and the HF resolve URL always redirects to
  // its CDN.
  await cache
    ?.put(
      new Request(keyFor(spec)),
      new Response(bytes.buffer as ArrayBuffer, {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    .catch((err: unknown) => log.warn('could not cache model; will refetch next time', err));

  return bytes;
}

export async function clearModels(): Promise<void> {
  await caches.delete(CACHE_NAME).catch(() => undefined);
}

/** Stream so first-run progress is real rather than a spinner that might be stuck. */
async function readWithProgress(
  res: Response,
  total: number,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  if (!res.body) {
    onProgress?.(1);
    return new Uint8Array(await res.arrayBuffer());
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) onProgress?.(Math.min(1, received / total));
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
