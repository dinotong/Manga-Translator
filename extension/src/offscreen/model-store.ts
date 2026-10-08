import { makeLog } from '../shared/log';
import { PipelineError } from '../shared/errors';

const log = makeLog('models');

/**
 * Model weights ship inside the extension package.
 *
 * They used to be downloaded on first use from a Hugging Face mirror. That was
 * fine while the only users were friends we could fix things for; for people
 * installing from a store it meant every new install depended on a personal
 * repository someone else owns staying up. The detector is 4.7 MB of
 * Apache-2.0 data, so the package carries it (docs/04-public-release-plan.md
 * 1.2). Upstream: PaddleOCR PP-OCRv4 det, via
 * huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx
 * sha256 d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9.
 *
 * Swapping in PP-OCRv5 later is a new file plus a version bump on the id (which
 * is part of the OCR cache key, so stale results invalidate themselves).
 */

export interface ModelSpec {
  id: string;
  /** Path inside the extension package (files live in extension/public). */
  path: string;
  /** Exact size. A truncated file shows up as "invalid protobuf" at load. */
  bytes: number;
  license: string;
}

export const PPOCR_DET: ModelSpec = {
  id: 'ppocr-v4-det',
  path: '/models/ppocr-v4-det.onnx',
  bytes: 4_745_517,
  license: 'Apache-2.0',
};

/** Where earlier versions kept downloaded weights; cleared once so the space comes back. */
const LEGACY_CACHE_NAME = 'mt-models';

/** How many bytes of this model the package actually carries. 0 = missing. */
export async function modelSize(spec: ModelSpec): Promise<number> {
  try {
    const res = await fetch(chrome.runtime.getURL(spec.path), { method: 'HEAD' });
    if (!res.ok) return 0;
    const n = Number(res.headers.get('content-length'));
    // Extension URLs do not always report a length; fall back to reading it.
    return Number.isFinite(n) && n > 0
      ? n
      : (await (await fetch(chrome.runtime.getURL(spec.path))).arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

export async function loadModel(
  spec: ModelSpec,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  void caches?.delete(LEGACY_CACHE_NAME).catch(() => undefined);

  let res: Response;
  try {
    res = await fetch(chrome.runtime.getURL(spec.path));
  } catch (err) {
    throw new PipelineError('MODEL_LOAD_FAILED', `could not read ${spec.id}: ${String(err)}`);
  }
  if (!res.ok) {
    throw new PipelineError('MODEL_LOAD_FAILED', `HTTP ${res.status} reading ${spec.id}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== spec.bytes) {
    throw new PipelineError(
      'MODEL_LOAD_FAILED',
      `${spec.id}: got ${bytes.byteLength} bytes, expected ${spec.bytes} — the package is damaged, reinstall it`,
    );
  }
  log.info(`loaded ${spec.id} from package (${(spec.bytes / 1e6).toFixed(1)} MB, ${spec.license})`);
  onProgress?.(1);
  return bytes;
}
