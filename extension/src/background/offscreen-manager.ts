import { PipelineError } from '../shared/errors';
import { makeLog } from '../shared/log';
import type { OffscreenReply, SwToOffscreen } from '../shared/messages';

const log = makeLog('offscreen-mgr');

const OFFSCREEN_URL = 'offscreen.html';

/**
 * Owns the lifetime of the one offscreen document.
 *
 * The service worker cannot host onnxruntime — no DOM, no WebGPU, and it gets
 * terminated after ~30 s idle, which would tear down a session that costs two
 * seconds to rebuild. So all ML lives in an offscreen document and the worker
 * only tells it what to do.
 *
 * The document closes itself after five idle minutes, so `ensureOffscreen` has
 * to assume it may be gone at any point rather than remembering that it once
 * created one — which is also the correct assumption for a worker that keeps
 * being restarted with its module state wiped.
 */
let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification:
        'Runs the ONNX text detector and decodes manga images; the service worker has no DOM or WebGPU.',
    })
    .catch((err: unknown) => {
      // Two calls can race past getContexts. Losing that race is fine — the
      // document exists either way, which is all the caller wanted.
      if (String(err).includes('Only a single offscreen document')) return;
      throw new PipelineError('OFFSCREEN_FAILED', String(err));
    })
    .finally(() => {
      creating = null;
    });

  await creating;
}

export async function closeOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}

export async function callOffscreen(msg: SwToOffscreen): Promise<OffscreenReply> {
  await ensureOffscreen();
  const reply = (await chrome.runtime.sendMessage({ __to: 'offscreen', msg })) as
    | OffscreenReply
    | undefined;

  if (!reply) {
    throw new PipelineError('OFFSCREEN_FAILED', 'offscreen document did not reply');
  }
  if (!reply.ok) {
    log.warn(`offscreen ${msg.t} failed: ${reply.message}`);
    throw new PipelineError(reply.code, reply.message, reply.hint);
  }
  return reply;
}
