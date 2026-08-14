import * as ort from 'onnxruntime-web';
// Let the bundler resolve the runtime assets and hand back extension URLs.
//
// The obvious alternative — copying these into public/ and pointing wasmPaths at
// the folder — does not work: ORT reaches its loader through a dynamic import(),
// and Vite refuses to serve anything from public/ that way. The "jsep" build is
// the combined one carrying both the CPU and WebGPU backends, so one pair of
// URLs covers either execution provider. Note the missing `dist/`: the package
// exports these assets by bare name.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import {
  COMPONENT_DEFAULTS,
  type ComponentOptions,
  connectedComponents,
  dilate,
} from '../core/components';
import { DIRECTION_DEFAULTS, detectDirection } from '../core/direction';
import { expandBox, planDetInput, rgbaToNchw } from '../core/preprocess';
import type { LangCode, TextLine } from '../types';
import { PipelineError } from '../shared/errors';
import { makeLog } from '../shared/log';
import { loadModel, PPOCR_DET } from './model-store';

const log = makeLog('detector');

/**
 * PP-OCRv4 mobile text detection via onnxruntime-web. Ported unchanged in spirit
 * from the M0 harness, which measured ~120 ms/page on WebGPU.
 *
 * PaddleOCR is used only to find *where* text is, never to read it — its
 * Japanese recogniser reads vertical lines as if they were horizontal. Detection
 * does not care what script it is looking at, which is what keeps adding English
 * later a recogniser swap rather than a rewrite.
 *
 * The model is a DB (differentiable binarization) net: it emits a per-pixel
 * probability map and turning that into line boxes is our job. That work lives
 * in core/ so it stays unit-testable without a browser.
 */

export type DetBackend = 'auto' | 'webgpu' | 'wasm';

export interface PpOcrOptions {
  backend: DetBackend;
  /** Long side of the model input. The main speed lever — cost is ~linear in pixels. */
  maxSide: number;
  expandRatio: number;
  components: ComponentOptions;
  /**
   * Mask dilation before labelling, as a fraction of the model input's long
   * edge. Without it, connected components returns one blob per glyph rather
   * than one per line.
   */
  dilateRatio: number;
  /** 1 to start: worker threads hit a different CSP inside extensions. */
  numThreads: number;
}

export const PP_OCR_DEFAULTS: PpOcrOptions = {
  backend: 'auto',
  maxSide: 960,
  expandRatio: 0.1,
  components: { ...COMPONENT_DEFAULTS, threshold: 0.3, minArea: 20, minSide: 3 },
  dilateRatio: 0.01,
  numThreads: 1,
};

export class PpOcrDetector {
  readonly id = 'ppocr-v4-det';
  readonly version = '1';
  readonly license = 'Apache-2.0';

  private session: ort.InferenceSession | null = null;
  /**
   * In-flight init, shared by every concurrent caller.
   *
   * Without this, a prewarm and a diagnostics probe arriving in the same tick
   * both see `session === null`, both download the 4.7 MB model, and both build
   * a session — at which point onnxruntime throws "Session already started" and
   * "Session mismatch". Observed in a real browser, not hypothetical.
   */
  private initing: Promise<void> | null = null;
  /**
   * Serialises inference.
   *
   * An InferenceSession is not reentrant: two overlapping run() calls on the
   * same session throw "Session already started" / "Session mismatch". That
   * happens for real — flipping the toggle prewarms while the first visible
   * page is already being detected. Queueing costs nothing here because the
   * pipeline is deliberately one-page-at-a-time anyway.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private opts: PpOcrOptions;
  /** Which backend actually loaded. 'auto' may fall back and the user must be able to see that. */
  private activeBackend: DetBackend = 'wasm';

  constructor(options: Partial<PpOcrOptions> = {}) {
    this.opts = { ...PP_OCR_DEFAULTS, ...options };
  }

  get backend(): DetBackend {
    return this.activeBackend;
  }

  get ready(): boolean {
    return this.session !== null;
  }

  /** Runtime-tunable knobs that must not require tearing down the session. */
  configure(patch: Partial<Pick<PpOcrOptions, 'dilateRatio'>>): void {
    this.opts = { ...this.opts, ...patch };
  }

  async init(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.session) return;
    this.initing ??= this.buildSession(onProgress).finally(() => {
      this.initing = null;
    });
    return this.initing;
  }

  private async buildSession(onProgress?: (fraction: number) => void): Promise<void> {
    ort.env.wasm.numThreads = this.opts.numThreads;
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    ort.env.logLevel = 'error';

    const bytes = await loadModel(PPOCR_DET, onProgress);

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
        log.info(`session ready on ${provider}`);
        return;
      } catch (err) {
        // WebGPU is missing on plenty of machines; falling back is normal,
        // silently pretending it succeeded is not.
        lastError = err;
        log.warn(`${provider} unavailable, trying next`, err);
      }
    }
    throw new PipelineError(
      'MODEL_LOAD_FAILED',
      `no execution provider available: ${String(lastError)}`,
    );
  }

  /**
   * Run one inference on a tiny blank input.
   *
   * WebGPU compiles shaders on first use, which M0 measured at 1.7-2.0 s. Paying
   * that when the user flips the toggle costs them nothing they notice; paying
   * it on the first page they open makes that page 15x slower than every page
   * after it, which reads as "this extension is broken" rather than "it is
   * warming up".
   */
  async prewarm(): Promise<void> {
    if (!this.session) await this.init();
    // Portrait, at a real page's proportions rather than a square: WebGPU
    // compiles shaders per input shape, so warming a shape nothing will ever
    // use pays the cost twice. 1280x1808 is a measured imhentai page and
    // downscales to the same 672x960 model input most manga pages land on.
    const canvas = new OffscreenCanvas(1280, 1808);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const bitmap = canvas.transferToImageBitmap();
    try {
      await this.detect(bitmap, 'ja');
    } finally {
      bitmap.close();
    }
  }

  detect(bitmap: ImageBitmap, lang: LangCode): Promise<TextLine[]> {
    const next = this.queue.then(
      () => this.detectNow(bitmap, lang),
      () => this.detectNow(bitmap, lang),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async detectNow(bitmap: ImageBitmap, lang: LangCode): Promise<TextLine[]> {
    const session = this.session;
    if (!session) throw new PipelineError('MODEL_LOAD_FAILED', `${this.id}: call init() first`);

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
    const mask = this.opts.dilateRatio > 0 ? dilate(probMap, input, radius, radius) : probMap;

    return connectedComponents(mask, input, this.opts.components).map((component) => {
      // Model space -> source bitmap space. Per-axis, because stride rounding
      // makes the two scales slightly different.
      const scaled = {
        x: component.rect.x * scaleBack.x,
        y: component.rect.y * scaleBack.y,
        w: component.rect.w * scaleBack.x,
        h: component.rect.h * scaleBack.y,
      };
      const rect = expandBox(scaled, this.opts.expandRatio, source);
      return { rect, score: component.score, direction: detectDirection(rect, dirOpts) };
    });
  }

  dispose(): void {
    void this.session?.release();
    this.session = null;
    this.initing = null;
  }
}
