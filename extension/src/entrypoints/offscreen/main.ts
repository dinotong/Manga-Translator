import type { PresetName } from '../../core/resolution';
import { releaseBytes, takeBytes } from '../../shared/blob-bridge';
import { toErrorPayload } from '../../shared/errors';
import { makeLog } from '../../shared/log';
import { isOffscreenCaller } from '../../shared/message-guards';
import type { Caps, OffscreenReply, SwToOffscreen } from '../../shared/messages';
import { DETECT_DEFAULTS, detectPage } from '../../offscreen/detect-page';
import { modelSize, PPOCR_DET } from '../../offscreen/model-store';
import { PpOcrDetector } from '../../offscreen/PpOcrDetector';

const log = makeLog('offscreen');

/**
 * The ML host.
 *
 * One detector instance for the lifetime of the document: an InferenceSession
 * costs 1.7-2.0 s of WebGPU shader compilation to create, so recreating one per
 * page would undo the entire reason this document is long-lived.
 */
let detector: PpOcrDetector | null = null;
let currentBackend: 'auto' | 'webgpu' | 'wasm' = 'auto';

/** Reset when a job starts or ends; fires window.close() when the tab of work dries up. */
const IDLE_CLOSE_MS = 5 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function touchIdle(): void {
  clearTimeout(idleTimer);
  // Self-closing rather than having the service worker do it on an alarm: the
  // worker is the thing that keeps dying, and "alarms" is a permission we would
  // have to ask the user for to solve a problem this document can solve itself.
  idleTimer = setTimeout(() => {
    log.info('idle, releasing ~500 MB of session memory');
    detector?.dispose();
    window.close();
  }, IDLE_CLOSE_MS);
}

/**
 * Choosing, replacing and using the detector happen one at a time. The worker
 * already serialises detections, but a prewarm (sent when settings change) can
 * arrive mid-detection, and swapping the runtime then would dispose the session
 * that detection is running on.
 */
let detectorChain: Promise<unknown> = Promise.resolve();

function withDetector<T>(task: () => Promise<T>): Promise<T> {
  const next = detectorChain.then(task, task);
  detectorChain = next.catch(() => undefined);
  return next;
}

async function getDetector(
  runtime: 'auto' | 'webgpu' | 'wasm',
  dilateRatio: number,
): Promise<PpOcrDetector> {
  if (detector && currentBackend !== runtime) {
    log.info(`runtime changed ${currentBackend} -> ${runtime}, rebuilding session`);
    detector.dispose();
    detector = null;
  }
  currentBackend = runtime;
  detector ??= new PpOcrDetector({ backend: runtime, dilateRatio });
  detector.configure({ dilateRatio });
  await detector.init();
  return detector;
}

chrome.runtime.onMessage.addListener(
  (raw: unknown, sender, sendResponse: (r: OffscreenReply) => void) => {
    // Every extension page receives every runtime message, so the envelope is
    // what stops the popup from trying to answer a detection request.
    const envelope = raw as { __to?: string; msg?: SwToOffscreen };
    if (envelope?.__to !== 'offscreen' || !envelope.msg) return false;
    // Only the worker drives the detector; a content script never may.
    if (!isOffscreenCaller(sender, { id: chrome.runtime.id, origin: chrome.runtime.getURL('') })) {
      return false;
    }

    handle(envelope.msg)
      .then(sendResponse)
      .catch((err: unknown) => sendResponse({ ok: false, ...toErrorPayload(err) }));
    return true;
  },
);

async function handle(msg: SwToOffscreen): Promise<OffscreenReply> {
  touchIdle();

  switch (msg.t) {
    case 'OFF_PREWARM': {
      return withDetector(async () => {
        const det = await getDetector(msg.runtime, msg.dilateRatio);
        const t0 = performance.now();
        await det.prewarm();
        log.info(`prewarmed on ${det.backend} in ${Math.round(performance.now() - t0)} ms`);
        return { ok: true } as const;
      });
    }

    case 'OFF_CAPS': {
      return { ok: true, caps: await caps() };
    }

    case 'OFF_DETECT': {
      try {
        const bytes = await takeBytes(msg.image);
        const result = await withDetector(async () =>
          detectPage(bytes, await getDetector(msg.runtime, msg.dilateRatio), {
            ...DETECT_DEFAULTS,
            preset: msg.preset as PresetName,
            rtl: msg.rtl,
            lang: msg.lang,
          }),
        );
        log.debug(
          `${msg.jobId}: ${result.blocks.length} blocks · decode ${Math.round(result.ms.decode)}ms · detect ${Math.round(result.ms.detect)}ms (${result.backend})`,
        );
        return { ok: true, result };
      } finally {
        await releaseBytes(msg.image);
        touchIdle();
      }
    }
  }
}

/**
 * Typed structurally rather than via @webgpu/types: the only thing we ask of
 * WebGPU here is "does an adapter exist and what is it called", and pulling in
 * the full type package for two fields is not worth the dependency.
 */
interface MinimalGpu {
  requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string } } | null>;
}

async function caps(): Promise<Caps> {
  let webgpu = false;
  let adapter = '';
  try {
    const gpu = (navigator as Navigator & { gpu?: MinimalGpu }).gpu;
    if (gpu) {
      const got = await gpu.requestAdapter();
      webgpu = got !== null;
      if (got) {
        adapter = got.info
          ? `${got.info.vendor ?? ''} ${got.info.architecture ?? ''}`.trim()
          : 'available';
      }
    }
  } catch {
    webgpu = false;
  }

  return {
    webgpu,
    adapter,
    backend: detector?.backend ?? 'not started',
    modelBytes: await modelSize(PPOCR_DET),
    ready: detector?.ready ?? false,
  };
}

log.info('ready');
touchIdle();
