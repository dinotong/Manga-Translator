import { inkRatio } from '../core/components';
import { padRect, toNorm } from '../core/geometry';
import { groupLinesIntoBlocks, readingOrder } from '../core/grouping';
import { type PresetName, PRESETS, planResolution, resolutionWarning } from '../core/resolution';
import { putBytes } from '../shared/blob-bridge';
import { PipelineError } from '../shared/errors';
import { resolveDetectionLang, type SourceLang } from '../shared/lang';
import type { DetectedBlock, DetectResult } from '../shared/messages';
import type { PpOcrDetector } from './PpOcrDetector';

/**
 * Stages 2-4 of the pipeline: decode, detect, group, crop.
 *
 * Recognition is deliberately absent. Gemini reads and translates in the same
 * request (ADR-001), so what leaves this function is geometry plus one small
 * WebP per bubble — never the whole page, which would cost far more tokens for
 * no extra accuracy.
 */

export interface DetectPageOptions {
  lang: SourceLang;
  preset: PresetName;
  rtl: boolean;
  /** Crops below this ink fraction never leave the machine. */
  minInkRatio: number;
  cropPadRatio: number;
}

export const DETECT_DEFAULTS: Omit<DetectPageOptions, 'lang'> = {
  preset: 'balanced',
  rtl: true,
  minInkRatio: 0.02,
  cropPadRatio: 0.06,
};

export async function detectPage(
  imageBytes: ArrayBuffer,
  detector: PpOcrDetector,
  options: DetectPageOptions,
): Promise<DetectResult> {
  const t0 = performance.now();

  let original: ImageBitmap;
  try {
    original = await createImageBitmap(new Blob([imageBytes]));
  } catch (err) {
    throw new PipelineError('ACQUIRE_FAILED', `could not decode image bytes: ${String(err)}`);
  }

  const natural = { w: original.width, h: original.height };
  const plan = planResolution(natural, PRESETS[options.preset]);

  // Two bitmaps: a small one to find text on, a larger one to crop from. When
  // the source is already small, fitLongEdge clamps both to native and the
  // second createImageBitmap is nearly free.
  const [detBitmap, recBitmap] = await Promise.all([
    createImageBitmap(original, { resizeWidth: plan.det.w, resizeQuality: 'high' }),
    createImageBitmap(original, { resizeWidth: plan.rec.w, resizeQuality: 'high' }),
  ]);
  original.close();
  const tDecode = performance.now() - t0;

  const t1 = performance.now();
  const lines = await detector.detect(detBitmap, resolveDetectionLang(options.lang));
  const tDetect = performance.now() - t1;

  const t2 = performance.now();
  const blocks = readingOrder(groupLinesIntoBlocks(lines), options.rtl);
  const tGroup = performance.now() - t2;

  const detToRec = plan.rec.w / plan.det.w;
  const out: DetectedBlock[] = [];

  for (const block of blocks) {
    const scaled = {
      x: block.rect.x * detToRec,
      y: block.rect.y * detToRec,
      w: block.rect.w * detToRec,
      h: block.rect.h * detToRec,
    };
    const padded = padRect(scaled, options.cropPadRatio, plan.rec);
    const crop = await createImageBitmap(
      recBitmap,
      Math.round(padded.x),
      Math.round(padded.y),
      Math.max(1, Math.round(padded.w)),
      Math.max(1, Math.round(padded.h)),
    );

    try {
      // Blank crops are filtered before anything leaves the machine. A vision
      // API charges for them, and a local recogniser would invent a fluent,
      // entirely wrong sentence rather than admit the crop was empty.
      if (!isInky(crop, options.minInkRatio)) continue;

      const webp = await encodeWebp(crop);
      const ref = await putBytes(`crop-${crypto.randomUUID()}`, webp, 'image/webp');
      out.push({
        rect: toNorm(block.rect, plan.det),
        direction: block.direction,
        score: block.score,
        cropRef: ref,
      });
    } finally {
      crop.close();
    }
  }

  detBitmap.close();
  recBitmap.close();

  return {
    natural,
    detSize: plan.det,
    blocks: out,
    detectorId: `${detector.id}@${detector.version}`,
    backend: detector.backend,
    warning: resolutionWarning(plan.det),
    ms: { decode: tDecode, detect: tDetect, group: tGroup },
  };
}

/** Is there enough ink here to be text at all? */
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

/** WebP at 0.85: bubble crops are line art, and the size saving is what keeps the request small. */
async function encodeWebp(bitmap: ImageBitmap): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  return blob.arrayBuffer();
}
