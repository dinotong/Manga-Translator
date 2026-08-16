import * as ort from 'onnxruntime-web';
// Let Vite resolve the runtime assets and hand back URLs.
//
// The obvious alternative — copying these into public/ and pointing wasmPaths
// at the folder — does not work: ORT reaches its loader via a dynamic import(),
// and Vite refuses to serve anything from public/ through the import pipeline.
// The "jsep" build is the combined one, carrying both the CPU and WebGPU
// backends, so a single pair of URLs covers either execution provider.
// Note the missing `dist/`: the package exports these assets by bare name.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import {
  COMPONENT_DEFAULTS,
  type ComponentOptions,
  connectedComponents,
  dilate,
} from '../core/components';
import { DIRECTION_DEFAULTS, detectDirection } from '../core/direction';
import { suppressOverlaps } from '../core/geometry';
import { expandBox, planDetInput, rgbaToNchw, shrinkBox } from '../core/preprocess';
import type { LangCode, TextLine } from '../types';
import { ModelNotDownloadedError, type TextDetector } from './types';

/**
 * PP-OCRv4 mobile text detection via onnxruntime-web.
 *
 * We use PaddleOCR only to find *where* text is, never to read it — its
 * Japanese recognizer reads vertical lines as if they were horizontal, which is
 * exactly the failure manga-ocr exists to avoid. Detection, though, does not
 * care what script it is looking at, which is what makes adding English later a
 * recognizer swap rather than a rewrite.
 *
 * The model is a DB (differentiable binarization) net: it emits a per-pixel
 * probability map, and turning that into line boxes is our job. That work lives
 * in core/components.ts and core/preprocess.ts so it stays unit-testable.
 */

export type DetBackend = 'auto' | 'webgpu' | 'wasm';

export interface PpOcrOptions {
  modelUrl: string;
  backend: DetBackend;
  /** Long side of the model input. The main speed lever — cost is ~linear in pixels. */
  maxSide: number;
  /** DB shrink compensation. Small on purpose; see expandBox. */
  expandRatio: number;
  components: ComponentOptions;
  /**
   * Mask dilation before labelling, as a fraction of the model input's long
   * edge. Without it, connected components returns one blob per glyph rather
   * than one per line — see dilate() in core/components.ts.
   */
  dilateRatio: number;
  /**
   * Drop the lower-scoring of two boxes overlapping by more than this IoU.
   * See suppressOverlaps in core/geometry.ts for why it is set this high.
   */
  nmsIou: number;
  /** 1 to start: worker threads hit a different CSP inside extensions. */
  numThreads: number;
}

/** The knobs that only affect post-processing, so changing them needs no new session. */
export type PostprocessOptions = Pick<PpOcrOptions, 'dilateRatio' | 'nmsIou'>;

export const PP_OCR_DEFAULTS: PpOcrOptions = {
  modelUrl: '/models/ppocr-v4-det.onnx',
  backend: 'auto',
  maxSide: 960,
  expandRatio: 0.1,
  components: { ...COMPONENT_DEFAULTS, threshold: 0.3, minArea: 20, minSide: 3 },
  // D-009 measured 0.015 over 18 fixtures and picked it. The extension ships
  // 0.01, and the harness's job is to show what the extension will do, so the
  // default follows the extension and the sweep stays available in the UI.
  dilateRatio: 0.01,
  // Off, because the extension no longer runs it: `suppressOverlaps` is still in
  // core/geometry.ts but nothing in extension/src calls it. Leaving it on here
  // would make the harness quietly drop boxes the extension keeps.
  nmsIou: 1,
  numThreads: 1,
};

export class PpOcrDetector implements TextDetector {
  readonly id = 'ppocr-v4-det';
  readonly version = '1';
  readonly license = 'Apache-2.0';

  private session: ort.InferenceSession | null = null;
  private opts: PpOcrOptions;
  /** Which backend actually loaded — 'auto' may fall back, and the benchmark must say which. */
  private activeBackend: DetBackend = 'wasm';

  constructor(options: Partial<PpOcrOptions> = {}) {
    this.opts = { ...PP_OCR_DEFAULTS, ...options };
  }

  get backend(): DetBackend {
    return this.activeBackend;
  }

  get postprocess(): PostprocessOptions {
    return { dilateRatio: this.opts.dilateRatio, nmsIou: this.opts.nmsIou };
  }

  /**
   * Retune post-processing without rebuilding the session.
   *
   * These knobs are the ones worth sweeping by hand, and a WebGPU session costs
   * ~1.7 s of shader compilation to create (ADR-001). Tying them to construction
   * would make every step of a sweep pay that again for a decision the model was
   * never part of.
   */
  setPostprocess(patch: Partial<PostprocessOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  async init(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.session) return;

    ort.env.wasm.numThreads = this.opts.numThreads;
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    ort.env.logLevel = 'error';

    const res = await fetch(this.opts.modelUrl);
    if (!res.ok) throw new ModelNotDownloadedError(this.id, this.opts.modelUrl);

    const total = Number(res.headers.get('content-length') ?? 0);
    const bytes = await readWithProgress(res, total, onProgress);

    const providers: DetBackend[] =
      this.opts.backend === 'auto' ? ['webgpu', 'wasm'] : [this.opts.backend];

    let lastError: unknown;
    for (const provider of providers) {
      try {
        this.session = await ort.InferenceSession.create(bytes, {
          executionProviders: [provider],
          graphOptimizationLevel: 'all',
        });
        this.activeBackend = provider;
        return;
      } catch (err) {
        // WebGPU is unavailable on plenty of machines; falling back is normal,
        // silently pretending it succeeded is not.
        lastError = err;
        console.warn(`[${this.id}] ${provider} unavailable, trying next`, err);
      }
    }
    throw new Error(`no execution provider available: ${String(lastError)}`);
  }

  async detect(bitmap: ImageBitmap, lang: LangCode): Promise<TextLine[]> {
    const session = this.session;
    if (!session) throw new Error(`${this.id}: call init() first`);

    const source = { w: bitmap.width, h: bitmap.height };
    const { input, scaleBack } = planDetInput(source, this.opts.maxSide);

    const canvas = new OffscreenCanvas(input.w, input.h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, input.w, input.h);
    const { data } = ctx.getImageData(0, 0, input.w, input.h);

    const inputName = session.inputNames[0]!;
    const outputName = session.outputNames[0]!;
    const tensor = new ort.Tensor('float32', rgbaToNchw(data, input), [1, 3, input.h, input.w]);

    const output = await session.run({ [inputName]: tensor });
    const probMap = output[outputName]?.data as Float32Array | undefined;
    if (!probMap) throw new Error(`${this.id}: missing output "${outputName}"`);

    const dirOpts = DIRECTION_DEFAULTS[lang];

    // Join glyphs into lines before labelling. Without this every kana comes
    // back as its own "line", grouping never assembles a sentence, and the
    // translator is handed single characters.
    const radius = Math.max(1, Math.round(Math.max(input.w, input.h) * this.opts.dilateRatio));
    const mask = radius > 0 ? dilate(probMap, input, radius, radius) : probMap;

    const lines = connectedComponents(mask, input, this.opts.components).map((component) => {
      // Shrink by the radius that was dilated on, in model space and before
      // scaling. Dilation is how lines are *found*, not how they are measured;
      // leaving it in inflates every box by the structuring element, which at a
      // 14px radius more than doubles a column of vertical Japanese. The
      // extension does this — see extension/src/core/preprocess.ts — so a
      // harness that skips it groups differently from what ships.
      const tight = shrinkBox(component.rect, radius);
      // Model space -> source bitmap space. Per-axis, because stride rounding
      // makes the two scales slightly different.
      const scaled = {
        x: tight.x * scaleBack.x,
        y: tight.y * scaleBack.y,
        w: tight.w * scaleBack.x,
        h: tight.h * scaleBack.y,
      };
      const rect = expandBox(scaled, this.opts.expandRatio, source);
      return { rect, score: component.score, direction: detectDirection(rect, dirOpts) };
    });

    // Deduplicate here, before grouping: two boxes over one line would otherwise
    // survive as one block with a doubled bounding box, and the crop sent for
    // recognition would be subtly wrong rather than obviously duplicated.
    const kept = suppressOverlaps(lines, this.opts.nmsIou);
    if (kept.length < lines.length) {
      // Only when it fires. A suppression that silently removes real lines and a
      // suppression that never runs at all look identical from the outside.
      console.debug(`[${this.id}] nms dropped ${lines.length - kept.length}/${lines.length} boxes`);
    }
    return kept;
  }

  dispose(): void {
    void this.session?.release();
    this.session = null;
  }
}

/** Stream the model so first-run progress is real rather than a spinner. */
async function readWithProgress(
  res: Response,
  total: number,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  if (!res.body || total <= 0) {
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
    onProgress?.(received / total);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
