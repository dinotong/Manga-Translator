import { getOcr, getTranslations, putOcr, putTranslations, evictIfNeeded } from '../cache/stores';
import { ocrKey, type OcrBlockRecord, translationKey } from '../cache/db';
import { putBytes, releaseBytes, takeBytes } from '../shared/blob-bridge';
import { PipelineError } from '../shared/errors';
import { textHash } from '../shared/hash';
import { makeLog } from '../shared/log';
import type { JobSource, OverlayBlock, Stage } from '../shared/messages';
import type { Settings } from '../shared/settings';
import { KeyRing } from '../translation/KeyRing';
import { fetchImage } from './image-fetch';
import { callOffscreen } from './offscreen-manager';

const log = makeLog('pipeline');

export interface JobOutcome {
  hash: string;
  natural: { w: number; h: number };
  blocks: OverlayBlock[];
  fromCache: boolean;
  warning: string | null;
}

/**
 * Last few bubbles of the previous page, per reading set.
 *
 * Best effort by design: the service worker is torn down constantly and this
 * will be empty after that. Losing continuity context degrades one page's
 * pronouns; persisting it would mean an IndexedDB round trip on the hot path to
 * protect against something that barely matters.
 */
const recentContext = new Map<string, { src: string; out: string }[]>();

export async function runJob(
  source: JobSource,
  settings: Settings,
  onProgress: (stage: Stage, detail?: string) => void,
  signal?: AbortSignal,
): Promise<JobOutcome> {
  const from = settings.lang.source;
  const to = settings.lang.target;

  const gemini = await KeyRing.create(
    settings,
    {
      from,
      to,
      ...(source.setKey && settings.translation.contextBubbles > 0
        ? { context: (recentContext.get(source.setKey) ?? []).slice(-settings.translation.contextBubbles) }
        : {}),
    },
    {
      // A prefetch never waits out a per-minute limit. Jobs are serialised, so
      // parking a speculative page for 30 seconds also parks the page the
      // reader is actually looking at — the exact inversion prefetch exists to
      // avoid. It just fails; nobody is waiting for it.
      maxWaitMs: source.prefetch ? 0 : 45_000,
      onWait: (ms) =>
        onProgress('translate', `โควตาต่อนาทีเต็ม — รอ ${Math.ceil(ms / 1000)} วินาที`),
    },
  );

  /* ---- 1. bytes ---- */
  onProgress('acquire');
  const acquired = await acquire(source);

  /* ---- 2. OCR cache ---- */
  const detectorId = 'ppocr-v4-det@1';
  const key = ocrKey(detectorId, gemini.recognizerId, from, acquired.hash);

  const cached = !source.force ? await getOcr(key) : undefined;
  if (cached) {
    log.debug(`ocr hit ${acquired.hash}`);
    const blocks = await translateCached(cached.blocks, gemini, settings, signal);
    remember(source.setKey, blocks, settings.translation.contextBubbles);
    return {
      hash: acquired.hash,
      natural: cached.natural,
      blocks,
      fromCache: true,
      warning: null,
    };
  }

  /* ---- 3. detect (offscreen) ---- */
  onProgress('detect');
  const parked = await putBytes(acquired.hash, acquired.bytes, acquired.type);

  let detect;
  try {
    const reply = await callOffscreen({
      t: 'OFF_DETECT',
      jobId: source.elementKey,
      image: parked,
      lang: from,
      preset: settings.ocr.preset,
      runtime: settings.ocr.runtime,
      dilateRatio: settings.ocr.dilateRatio,
      // Reading order only feeds the model's context; the overlay draws each
      // box where it is, so getting this wrong is a quality issue, not a
      // correctness one.
      rtl: from !== 'en',
    });
    if (!('result' in reply)) throw new PipelineError('UNKNOWN', 'offscreen returned no result');
    detect = reply.result;
  } finally {
    await releaseBytes(parked);
  }

  if (detect.blocks.length === 0) {
    if (detect.warning) throw new PipelineError('LOW_RESOLUTION', detect.warning);
    throw new PipelineError('NO_TEXT_FOUND', 'detector found no text regions');
  }

  /* ---- 4. read + translate in one request ---- */
  onProgress('translate', `${detect.blocks.length} กล่อง`);
  const crops = await Promise.all(detect.blocks.map((b) => takeBytes(b.cropRef)));

  let items: ({ src: string; out: string } | null)[];
  try {
    items = await gemini.readPage(crops, signal);
  } catch (err) {
    if (err instanceof PipelineError && err.code === 'PROVIDER_REFUSED') {
      // One panel poisoned the batch. Re-ask bubble by bubble so the rest of the
      // page still gets translated — losing eight good bubbles to protect the
      // user from one is not a trade they would choose.
      log.warn('page refused, retrying per block');
      onProgress('translate', 'ถูกปฏิเสธ — ลองแยกทีละกล่อง');
      items = await gemini.readPageIndividually(crops, signal);
    } else {
      throw err;
    }
  } finally {
    await Promise.all(detect.blocks.map((b) => releaseBytes(b.cropRef)));
  }

  /* ---- 5. persist, split across the two stores ---- */
  const records: OcrBlockRecord[] = [];
  const blocks: OverlayBlock[] = [];
  const pairs: { src: string; out: string }[] = [];

  detect.blocks.forEach((b, i) => {
    const item = items[i];
    if (!item) {
      // Refused individually. Keep the box so the user can see which panel was
      // dropped rather than silently losing it.
      blocks.push({ rect: b.rect, text: '', source: '', direction: b.direction, refused: true });
      return;
    }
    const src = item.src.trim();
    const out = item.out.trim();
    if (!src && !out) return; // the model saw nothing readable in this crop

    records.push({ rect: b.rect, src, direction: b.direction, score: b.score });
    blocks.push({ rect: b.rect, text: out || src, source: src, direction: b.direction });
    if (src && out) pairs.push({ src, out });
  });

  await putOcr({
    key,
    imageHash: acquired.hash,
    from,
    natural: detect.natural,
    blocks: records,
  });

  await putTranslations(
    await Promise.all(
      pairs.map(async (p) => ({
        key: translationKey(gemini.id, gemini.model, from, to, await textHash(p.src)),
        from,
        to,
        src: p.src,
        out: p.out,
      })),
    ),
  );

  void evictIfNeeded().then((n) => n > 0 && log.info(`evicted ${n} ocr records`));
  remember(source.setKey, blocks, settings.translation.contextBubbles);

  return {
    hash: acquired.hash,
    natural: detect.natural,
    blocks,
    fromCache: false,
    warning: detect.warning,
  };
}

/**
 * Reuse a cached reading, translating only what is missing.
 *
 * This is what the two-store split buys: switching target language or model
 * re-runs the cheap half and leaves the detection and reading — a GPU pass and
 * an image request — untouched.
 */
async function translateCached(
  records: readonly OcrBlockRecord[],
  gemini: KeyRing,
  settings: Settings,
  signal?: AbortSignal,
): Promise<OverlayBlock[]> {
  const from = settings.lang.source;
  const to = settings.lang.target;

  const keys = await Promise.all(
    records.map(async (r) =>
      translationKey(gemini.id, gemini.model, from, to, await textHash(r.src)),
    ),
  );
  const hits = await getTranslations(keys);

  const missing = records
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !hits.has(keys[i] ?? ''));

  if (missing.length > 0) {
    const outs = await gemini.translateBatch(
      missing.map((m) => m.r.src),
      signal,
    );
    await putTranslations(
      missing.map((m, n) => ({
        key: keys[m.i]!,
        from,
        to,
        src: m.r.src,
        out: outs[n] ?? '',
      })),
    );
    missing.forEach((m, n) => hits.set(keys[m.i]!, outs[n] ?? ''));
  }

  return records.map((r, i) => ({
    rect: r.rect,
    text: hits.get(keys[i] ?? '') || r.src,
    source: r.src,
    direction: r.direction,
  }));
}

/** Bytes, from whichever of the two acquisition paths applies. */
async function acquire(
  source: JobSource,
): Promise<{ bytes: ArrayBuffer; hash: string; type: string }> {
  if (source.image) {
    // The content script already read it — blob:, data: or same-origin, where
    // the service worker either cannot see the URL at all or has no advantage.
    return {
      bytes: await takeBytes(source.image),
      hash: source.image.hash,
      type: 'application/octet-stream',
    };
  }
  if (!source.url) {
    throw new PipelineError('ACQUIRE_FAILED', 'job has neither bytes nor a URL');
  }
  return fetchImage(source.url);
}

function remember(setKey: string | null, blocks: readonly OverlayBlock[], keep: number): void {
  if (!setKey || keep <= 0) return;
  const usable = blocks.filter((b) => b.source && b.text).map((b) => ({ src: b.source, out: b.text }));
  recentContext.set(setKey, usable.slice(-keep));
}
