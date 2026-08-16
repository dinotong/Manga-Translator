import { inkRatio } from './core/components';
import { blockGlyph, DIRECTION_DEFAULTS } from './core/direction';
import { padRect, toNorm } from './core/geometry';
import { groupLinesIntoBlocks, readingOrder } from './core/grouping';
import {
  type MergeableBlock,
  type MergeRejection,
  planMerges,
} from './core/merge-proposals';
import { type PresetName, PRESETS, planResolution, resolutionWarning } from './core/resolution';
import type { RoutedGroup } from './core/batch';
import { Timer } from './bench/timer';
import { cropBitmap, type TextDetector, type TextRecognizer } from './ocr/types';
import type { LangCode, OutputBlock, PipelineResult, Size } from './types';

export interface PipelineOptions {
  lang: LangCode;
  preset: PresetName;
  rtl: boolean;
  /** Crops below this ink fraction are skipped — see below. */
  minInkRatio: number;
  /** Padding added around each block before cropping, as a fraction of its size. */
  cropPadRatio: number;
}

export const PIPELINE_DEFAULTS: PipelineOptions = {
  lang: 'ja',
  preset: 'balanced',
  rtl: true,
  minInkRatio: 0.02,
  cropPadRatio: 0.06,
};

export interface PipelineDeps {
  detector: TextDetector;
  recognizer: TextRecognizer;
  /**
   * Text mode: recognition happens locally and only strings go to the API.
   * Far fewer tokens than shipping crops, at the cost of needing a local
   * recognizer fast enough to be worth it. Omit for vision mode.
   */
  translator?: TextTranslator;
  onProgress?: (stage: string, detail?: string) => void;
}

export interface TextTranslator {
  readonly id: string;
  translateBatch(texts: readonly string[]): Promise<{ src: string; out: string }[]>;
}

/**
 * Optional capability: read a whole page of crops in one shot.
 *
 * A vision API bills per request, so sending nine bubbles as nine calls burns
 * nine times the quota and loses the cross-bubble context that makes the
 * translation coherent. Recognizers that can batch advertise it here.
 */
export interface PageReader {
  readPage(crops: readonly ImageBitmap[]): Promise<{
    items: ({ src: string; out: string } | null)[];
    groups: RoutedGroup[];
  }>;
}

/** What the model asked for, and what geometry did about it. */
export interface GroupingReport {
  /** Blocks before any merging, so the count can be compared with `after`. */
  before: number;
  after: number;
  accepted: { blocks: number[]; src: string; out: string }[];
  rejected: { blocks: number[]; reason: MergeRejection }[];
}

/** A block that may have been assembled from several detected ones. */
export interface HarnessBlock extends OutputBlock {
  /** How many detected blocks went into it. 1 for everything the model left alone. */
  parts: number;
}

export interface HarnessResult extends Omit<PipelineResult, 'blocks'> {
  blocks: HarnessBlock[];
  warning: string | null;
  grouping: GroupingReport;
}

/**
 * The whole M0 pipeline: decode -> detect -> group -> recognize -> normalize.
 *
 * Translation is deliberately absent. M0 answers one question — is browser OCR
 * fast and accurate enough to drive translate-on-scroll — and adding a network
 * round trip to the measurement would only obscure it.
 */
export async function runPipeline(
  source: ImageBitmap | Blob,
  deps: PipelineDeps,
  options: Partial<PipelineOptions> = {},
): Promise<HarnessResult> {
  const opts = { ...PIPELINE_DEFAULTS, ...options };
  const timer = new Timer();
  const perBlock: number[] = [];
  const grouping: GroupingReport = { before: 0, after: 0, accepted: [], rejected: [] };

  const original = await timer.stage('decode', async () =>
    source instanceof Blob ? createImageBitmap(source) : source,
  );
  const natural: Size = { w: original.width, h: original.height };
  const plan = planResolution(natural, PRESETS[opts.preset]);

  // Two bitmaps: a small one to find text on, a larger one to crop from. On
  // small sources fitLongEdge clamps both to native, so this costs nothing.
  const [detBitmap, recBitmap] = await timer.stage('decode', async () =>
    Promise.all([
      createImageBitmap(original, { resizeWidth: plan.det.w, resizeQuality: 'high' }),
      createImageBitmap(original, { resizeWidth: plan.rec.w, resizeQuality: 'high' }),
    ]),
  );

  deps.onProgress?.('detect');
  const rawLines = await timer.stage('detect', () => deps.detector.detect(detBitmap, opts.lang));

  deps.onProgress?.('group', `${rawLines.length} lines`);
  const blocks = await timer.stage('group', async () => {
    const grouped = groupLinesIntoBlocks(rawLines, opts.lang);
    return readingOrder(grouped, opts.rtl);
  });

  // Detection ran on detBitmap; crops come from recBitmap. Same normalized
  // geometry, different pixel scale.
  const detToRec = plan.rec.w / plan.det.w;

  deps.onProgress?.('recognize', `${blocks.length} blocks`);
  const out: HarnessBlock[] = [];
  const emit = (
    text: string,
    src: string,
    rect: OutputBlock['rect'],
    block: { direction: OutputBlock['direction']; score: number },
    parts: number,
  ) => {
    out.push({
      rect,
      text,
      source: src,
      direction: block.direction,
      lang: opts.lang,
      score: block.score,
      parts,
    });
  };

  // Crop every bubble first. The ink check happens here so blank crops never
  // reach the recognizer — manga-ocr invents text for them, and a vision API
  // charges a request for the privilege.
  const crops: { block: (typeof blocks)[number]; crop: ImageBitmap; inky: boolean }[] = [];
  for (const block of blocks) {
    const scaled = {
      x: block.rect.x * detToRec,
      y: block.rect.y * detToRec,
      w: block.rect.w * detToRec,
      h: block.rect.h * detToRec,
    };
    const padded = padRect(scaled, opts.cropPadRatio, plan.rec);
    const crop = await cropBitmap(recBitmap, padded);
    crops.push({ block, crop, inky: isInky(crop, opts.minInkRatio) });
  }

  const live = crops.filter((c) => c.inky);
  if (live.length < crops.length) {
    // The ink filter runs before any recognizer, so a page that renders nothing
    // may never have reached one. Distinguishing "detected nothing", "skipped
    // as blank" and "recognized nothing" is the difference between tuning the
    // detector and debugging the model.
    console.debug(`[pipeline] ink filter skipped ${crops.length - live.length}/${crops.length}`);
  }
  const reader = deps.recognizer as Partial<PageReader>;

  if (typeof reader.readPage === 'function' && live.length > 0) {
    // Whole page in one call. Beyond being far faster, it lets the model see
    // every bubble at once, so tone and pronouns stay consistent across them.
    const t0 = performance.now();
    const reading = await reader.readPage(live.map((c) => c.crop));
    const each = (performance.now() - t0) / live.length;
    live.forEach(() => perBlock.push(each));

    // The model may claim some of those crops are one continuous text. Geometry
    // decides whether to believe it — same module, same limits as the extension.
    grouping.before = live.length;
    const aspect = natural.w > 0 ? natural.h / natural.w : 1;
    const mergeable: MergeableBlock[] = live.map((c) => ({
      rect: toNorm(c.block.rect, plan.det),
      direction: c.block.direction,
      glyph: blockGlyph(c.block.lines, c.block.direction) / plan.det.w,
    }));
    const merges = planMerges(
      mergeable,
      reading.groups.map((g) => ({ members: g.blocks })),
      aspect,
    );

    /** live index -> the accepted merge that owns it. */
    const owner = new Map<number, (typeof merges.accepted)[number]>();
    for (const a of merges.accepted) for (const m of a.members) owner.set(m, a);

    grouping.accepted = merges.accepted.map((a) => ({
      blocks: a.members,
      src: reading.groups[a.proposal]?.src ?? '',
      out: reading.groups[a.proposal]?.out ?? '',
    }));
    grouping.rejected = merges.rejected.map((r) => ({ blocks: r.members, reason: r.reason }));

    live.forEach((c, i) => {
      const merge = owner.get(i);
      // A merged block is emitted once, at the position of its first member, so
      // the page keeps reading order.
      if (merge && merge.members[0] !== i) return;

      if (merge) {
        const claim = reading.groups[merge.proposal];
        const parts = merge.members.map((m) => reading.items[m]);
        // The joined fallback exists for the case where the model names the
        // group but gives it no text: the fragments it already returned are
        // still better than nothing, and they are in reading order.
        const src = claim?.src?.trim() || parts.map((r) => r?.src ?? '').join('');
        const out = claim?.out?.trim() || parts.map((r) => r?.out ?? '').join('');
        if (!isPlausible(out || src)) return;
        emit(out, src, merge.rect, c.block, merge.members.length);
        return;
      }

      const r = reading.items[i];
      if (r && isPlausible(r.src || r.out)) {
        emit(r.out || r.src, r.src, toNorm(c.block.rect, plan.det), c.block, 1);
      }
    });

    grouping.after = out.length;
  } else {
    const recognized: string[] = [];
    for (const [i, c] of live.entries()) {
      const t0 = performance.now();
      recognized.push(await deps.recognizer.recognize(c.crop, c.block));
      perBlock.push(performance.now() - t0);
      deps.onProgress?.('recognize', `${i + 1}/${live.length}`);
    }

    // Text mode: one request for the page's strings, so the API never sees an
    // image and the token cost drops by an order of magnitude.
    let translated: { src: string; out: string }[] | null = null;
    if (deps.translator && recognized.some((t) => t.trim())) {
      deps.onProgress?.('translate', deps.translator.id);
      translated = await timer.stage('translate', () =>
        deps.translator!.translateBatch(recognized),
      );
    }

    // Guards that silently drop everything are worse than no guards: a page
    // that spent 50s recognizing and then rendered nothing gives you no way to
    // tell whether detection, recognition or the plausibility filter was at
    // fault. Log what was thrown away and why.
    const dropped: { i: number; reason: string; raw: string }[] = [];

    live.forEach((c, i) => {
      const src = recognized[i] ?? '';
      const text = translated?.[i]?.out || src;
      if (!isPlausible(text)) {
        dropped.push({
          i,
          reason: text.trim() ? 'degenerate (repeated chars)' : 'empty output',
          raw: src.slice(0, 40),
        });
        return;
      }
      emit(text, translated ? src : '', toNorm(c.block.rect, plan.det), c.block, 1);
    });

    // The local-recogniser path never asks the model to group anything: it sends
    // strings, not the page, so there is nothing to group with.
    grouping.before = live.length;
    grouping.after = out.length;

    if (dropped.length > 0) {
      console.warn(
        `[pipeline] dropped ${dropped.length}/${live.length} blocks after recognition`,
        dropped,
      );
      deps.onProgress?.('recognize', `ทิ้ง ${dropped.length}/${live.length} block — ดู console`);
    }
  }

  for (const c of crops) c.crop.close();

  detBitmap.close();
  recBitmap.close();
  if (source instanceof Blob) original.close();

  return {
    blocks: out,
    grouping,
    natural,
    detSize: plan.det,
    detectorId: `${deps.detector.id}@${deps.detector.version}`,
    recognizerId: `${deps.recognizer.id}@${deps.recognizer.version}`,
    warning: resolutionWarning(plan.det),
    timings: {
      decode: timer.get('decode'),
      detect: timer.get('detect'),
      group: timer.get('group'),
      recognize: timer.get('recognize'),
      total: timer.total,
      perBlock,
    },
  };
}

/**
 * Guard 1 against hallucination: is there enough ink here to be text at all?
 *
 * manga-ocr never declines. Given an empty crop it returns a fluent, wrong
 * Japanese sentence, which is worse than returning nothing because it reads as
 * real. Cheaper to check the pixels than to second-guess the output.
 */
function isInky(crop: ImageBitmap, minRatio: number): boolean {
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;

  ctx.drawImage(crop, 0, 0);
  const { data } = ctx.getImageData(0, 0, crop.width, crop.height);
  const gray = new Float32Array(crop.width * crop.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec.601 luma, scaled to 0..1.
    gray[p] = (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) / 255;
  }
  return inkRatio(gray, { w: crop.width, h: crop.height }) >= minRatio;
}

const DEGENERATE = /(.)\1{5,}/u;

/**
 * Guard 2: reject output that looks like a decoder loop rather than a sentence.
 * Six identical characters in a row is not dialogue, it is the model spiralling.
 */
function isPlausible(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !DEGENERATE.test(trimmed);
}
