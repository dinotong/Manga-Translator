import { getOcr, getTranslations, putOcr, putTranslations, evictIfNeeded } from '../cache/stores';
import {
  blocksFor,
  OCR_RECORD_FORMAT,
  ocrKey,
  type OcrBlockRecord,
  servesGrouping,
  translationKey,
} from '../cache/db';
import { planMerges } from '../core/merge-proposals';
import type { RoutedGroup } from '../core/batch';
import { readPageBatched } from './read-batcher';
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
  // Opt-in. See shared/settings.ts for what it cost when it was not.
  const grouping = settings.translation.modelGrouping;

  const gemini = await KeyRing.create(
    settings,
    {
      from,
      to,
      grouping,
      ...(source.setKey && settings.translation.contextBubbles > 0
        ? { context: (recentContext.get(source.setKey) ?? []).slice(-settings.translation.contextBubbles) }
        : {}),
    },
    {
      // A prefetch used to be given zero patience, because jobs were serialised
      // and parking a speculative page for 30 seconds parked the page the reader
      // was actually looking at with it. Jobs run several at a time now, and one
      // slot is permanently reserved for non-speculative work
      // (core/scheduling.ts), so a waiting guess cannot hold the reader up. It
      // is given a real but smaller budget: the image has already been fetched
      // and the detector has already run on it, and throwing that away to save a
      // ten second wait is a bad trade.
      maxWaitMs: source.prefetch ? 15_000 : 45_000,
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

  const stored = !source.force ? await getOcr(key) : undefined;
  // A reader who turns grouping off must see it turn off on the pages they have
  // already read, without knowing that a cache exists. Records written since
  // `parts` can simply have the merge dropped; older ones cannot be un-merged,
  // so they are refused here and this one page is read again.
  const cached = stored && servesGrouping(stored, grouping) ? stored : undefined;
  if (stored && !cached) {
    log.info(`ocr record predates un-mergeable grouping, re-reading ${acquired.hash}`);
  }
  if (cached) {
    log.debug(`ocr hit ${acquired.hash}`);
    const blocks = await translateCached(blocksFor(cached.blocks, grouping), gemini, settings, signal);
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
    // Serialised, and only this step. ONNX sessions are not re-entrant (D-013),
    // so two detections at once produce `Session already started`. Measured at
    // 126-481 ms per page, so a queue here costs almost nothing — while the
    // Gemini call it used to be bundled with costs 1.3-41 s and has no such
    // constraint. Separating the two is the change; see core/scheduling.ts.
    const reply = await detectSerially(() =>
      callOffscreen({
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
      }),
    );
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
  let proposed: RoutedGroup[] = [];
  try {
    // Through the batcher: crops from up to three pages travel in one request,
    // which triples throughput without spending any more of the per-minute
    // budget. The page the reader is reading is dispatched immediately and never
    // waits for a batch to fill. See background/read-batcher.ts.
    const read = await readPageBatched({
      lane: readLane(source, from, to, gemini.model),
      jobId: source.elementKey,
      crops,
      // `reading`, not "on screen". On a long strip nearly every page is on
      // screen when its job starts, so that test called everything foreground
      // and nothing ever batched. See core/foreground.ts.
      kind: source.manual
        ? 'manual'
        : source.prefetch
          ? 'speculative'
          : source.reading
            ? 'foreground'
            : 'lookahead',
      ring: gemini,
      ...(signal ? { signal } : {}),
    });
    items = read.slots;
    proposed = read.groups;
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

  /* ---- 5. believe the model's grouping only where geometry agrees ---- */
  //
  // The model has read every crop and may say some of them are one continuous
  // sentence — the afterword case, where handwritten columns of uneven length
  // defeat the thresholds in core/grouping.ts. It is a proposal: core/
  // merge-proposals.ts refuses anything that was not already adjacent, is a
  // whole bubble rather than a fragment, has the wrong glyph size, or would
  // draw a plate over the artwork. A refusal costs nothing, because the reply
  // still carries one item per crop.
  const aspect = detect.natural.w > 0 ? detect.natural.h / detect.natural.w : 1;
  const merges = planMerges(
    detect.blocks.map((b) => ({ rect: b.rect, direction: b.direction, glyph: b.glyph })),
    proposed.map((g) => ({ members: g.blocks })),
    aspect,
  );
  if (proposed.length > 0) {
    log.info(
      `model proposed ${proposed.length} merge(s): ${merges.accepted.length} kept, ` +
        `${merges.rejected.map((r) => r.reason).join(',') || 'none'} refused`,
    );
  }
  /** Block index -> the merge that owns it. */
  const merged = new Map<number, (typeof merges.accepted)[number]>();
  for (const a of merges.accepted) for (const m of a.members) merged.set(m, a);

  /* ---- 6. persist, split across the two stores ---- */
  const records: OcrBlockRecord[] = [];
  const blocks: OverlayBlock[] = [];
  const pairs: { src: string; out: string }[] = [];

  detect.blocks.forEach((b, i) => {
    const owner = merged.get(i);
    // A merged run is written once, at its first member, so the page keeps
    // reading order and the other members simply vanish into it.
    if (owner && owner.members[0] !== i) return;

    if (owner) {
      const claim = proposed[owner.proposal];
      const read = owner.members.map((m) => items[m]);
      // The joined fallback covers a model that names a group but gives it no
      // text: the fragments it did return are in reading order and are better
      // than nothing.
      const src = (claim?.src ?? '').trim() || read.map((p) => p?.src ?? '').join('');
      const out = (claim?.out ?? '').trim() || read.map((p) => p?.out ?? '').join('');
      if (!src && !out) return;

      const score = owner.members.reduce((n, m) => n + (detect.blocks[m]?.score ?? 0), 0) /
        owner.members.length;
      // The members are kept on the record, and their own readings are cached
      // like any other. Between them, switching grouping off later costs
      // nothing at all: the merge is dropped here and every block underneath it
      // already has a translation. See cache/db.ts.
      const parts: OcrBlockRecord[] = [];
      owner.members.forEach((m, n) => {
        const block = detect.blocks[m];
        const item = read[n];
        if (!block || !item) return;
        const partSrc = item.src.trim();
        const partOut = item.out.trim();
        if (!partSrc && !partOut) return;
        parts.push({ rect: block.rect, src: partSrc, direction: block.direction, score: block.score });
        if (partSrc && partOut) pairs.push({ src: partSrc, out: partOut });
      });

      records.push({
        rect: owner.rect,
        src,
        direction: b.direction,
        score,
        ...(parts.length > 0 ? { parts } : {}),
      });
      blocks.push({ rect: owner.rect, text: out || src, source: src, direction: b.direction });
      if (src && out) pairs.push({ src, out });
      return;
    }

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

  // The records written here are the *merged* blocks, so the grouping is stored
  // with the reading under the image's hash and a second look at the page
  // reproduces it exactly. That matters more than it looks: the model is not
  // deterministic, and without this the same page could group one way now and
  // another way on the next read, which would make any bug in this area
  // impossible to reproduce and therefore impossible to fix.
  //
  // Reproducible is not the same as permanent, though, and the first version of
  // this wrote the merge in as if it were. Each merged record now carries the
  // blocks it was made of, so the reader can still take the merge back off
  // without re-reading the page. See cache/db.ts.
  await putOcr({
    key,
    imageHash: acquired.hash,
    from,
    natural: detect.natural,
    blocks: records,
    format: OCR_RECORD_FORMAT,
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

/**
 * Which pages may legally share one Gemini request.
 *
 * The language pair and the model decide what the prompt says, and the reading
 * set decides whose story it is: batching a page of one gallery with a page of
 * another would put two unrelated works in front of the model at once, and the
 * continuity context attached to the request belongs to exactly one of them.
 *
 * `setKey` is the right answer when a site profile supplies one. Where none
 * does, the reader's own page is the honest fallback — pages showing in the same
 * document are the same book by construction. It used to fall back to the
 * element key, which is unique per image and therefore put every page in a lane
 * of its own: measured, that meant not one request carried more than one page on
 * either target gallery, because neither has a profile. The query string and
 * fragment are dropped because both sites move through a gallery by changing
 * exactly those.
 *
 * A right-click needs no protection from this — it is dispatched alone whatever
 * lane it names (background/read-batcher.ts).
 */
function readLane(source: JobSource, from: string, to: string, model: string): string {
  return `${from}|${to}|${model}|${source.setKey ?? documentLane(source.pageUrl)}`;
}

function documentLane(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return `doc:${u.origin}${u.pathname}`;
  } catch {
    return `doc:${pageUrl}`;
  }
}

/**
 * Detection, one at a time, forever.
 *
 * D-013: the ONNX runtime rejects a second concurrent run on the same session
 * with `Session already started`. This is the only part of the pipeline with
 * that constraint, and keeping the chain here rather than around the whole job
 * is the entire point of the concurrency split.
 */
let detectChain: Promise<unknown> = Promise.resolve();

function detectSerially<T>(task: () => Promise<T>): Promise<T> {
  const next = detectChain.then(task, task);
  detectChain = next.catch(() => undefined);
  return next;
}

function remember(setKey: string | null, blocks: readonly OverlayBlock[], keep: number): void {
  if (!setKey || keep <= 0) return;
  const usable = blocks.filter((b) => b.source && b.text).map((b) => ({ src: b.source, out: b.text }));
  recentContext.set(setKey, usable.slice(-keep));
}
