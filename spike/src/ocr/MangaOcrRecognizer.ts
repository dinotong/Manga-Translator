import { env, pipeline, RawImage, type ImageToTextPipeline } from '@huggingface/transformers';
import type { LangCode, TextBlock } from '../types';
import type { TextRecognizer } from './types';

/**
 * manga-ocr (kha-white, Apache-2.0) via transformers.js.
 *
 * A ViT encoder feeding a BERT decoder, wrapped as VisionEncoderDecoder. It
 * reads an entire multi-line speech bubble in one pass and returns the text
 * already in reading order — which is why this project has no "reassemble
 * vertical characters" step at all. Grouping decides what one bubble is; the
 * model handles everything inside it.
 *
 * Two consequences worth remembering:
 *
 *  - Japanese only. English needs a different recognizer, not a flag.
 *  - It never declines. Hand it a blank crop and it invents a fluent sentence,
 *    so the ink-ratio and degenerate-output guards in pipeline.ts are load
 *    bearing, not defensive extras.
 *
 * Model choice: ms57rd/manga-ocr-base-ONNX. The onnx-community mirror looks
 * better stocked but ships no tokenizer.json, so its token ids can never be
 * decoded back into text.
 */

export type OcrDevice = 'webgpu' | 'wasm';
/** transformers.js dtype ids; 'q8' resolves to the *_quantized weights. */
export type OcrDtype = 'fp32' | 'fp16' | 'q8';

export interface MangaOcrOptions {
  modelId: string;
  device: OcrDevice;
  dtype: OcrDtype;
  /** Cap on generated tokens. A bubble is short; a long run means it is looping. */
  maxNewTokens: number;
}

export const MANGA_OCR_DEFAULTS: MangaOcrOptions = {
  // Served from our own origin (see scripts/download-models.mjs), not the Hub:
  // the COEP header the harness needs for wasm threads breaks the cross-origin
  // download, and the extension will ship weights locally regardless.
  modelId: 'manga-ocr-base',
  device: 'webgpu',
  dtype: 'q8',
  maxNewTokens: 64,
};

export class MangaOcrRecognizer implements TextRecognizer {
  readonly id = 'manga-ocr-base';
  readonly version = '1';
  readonly license = 'Apache-2.0';
  readonly langs: readonly LangCode[] = ['ja'];

  private pipe: ImageToTextPipeline | null = null;
  private readonly opts: MangaOcrOptions;
  private activeDevice: OcrDevice;

  constructor(options: Partial<MangaOcrOptions> = {}) {
    this.opts = { ...MANGA_OCR_DEFAULTS, ...options };
    this.activeDevice = this.opts.device;
  }

  get device(): OcrDevice {
    return this.activeDevice;
  }

  async init(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.pipe) return;

    // Load from public/models/ on our own origin rather than the Hub.
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = '/models/';
    env.useBrowserCache = true;

    const devices: OcrDevice[] =
      this.opts.device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];

    let lastError: unknown;
    for (const device of devices) {
      try {
        this.pipe = await pipeline('image-to-text', this.opts.modelId, {
          device,
          dtype: { encoder_model: this.opts.dtype, decoder_model_merged: this.opts.dtype },
          progress_callback: (p: { status?: string; progress?: number }) => {
            if (p.status === 'progress' && typeof p.progress === 'number') {
              onProgress?.(p.progress / 100);
            }
          },
        });
        this.activeDevice = device;
        return;
      } catch (err) {
        // int8 kernels are not uniformly available on the WebGPU backend, so a
        // fall back to wasm here is expected on some machines — but it must be
        // visible, because it changes the benchmark numbers completely.
        lastError = err;
        console.warn(`[${this.id}] ${device} failed, trying next`, err);
      }
    }
    throw new Error(`manga-ocr failed to load: ${String(lastError)}`);
  }

  async recognize(crop: ImageBitmap, _block: TextBlock): Promise<string> {
    const pipe = this.pipe;
    if (!pipe) throw new Error(`${this.id}: call init() first`);

    const output = await pipe(toRawImage(crop), {
      max_new_tokens: this.opts.maxNewTokens,
      // Greedy. Sampling would make repeat runs unreproducible, and a benchmark
      // whose numbers move between runs is not a benchmark.
      do_sample: false,
    });

    const first = Array.isArray(output) ? output[0] : output;
    const text = (first as { generated_text?: string } | undefined)?.generated_text ?? '';
    return text.trim();
  }

  dispose(): void {
    void this.pipe?.dispose();
    this.pipe = null;
  }
}

/** ImageBitmap -> RawImage, which is what transformers.js preprocessors accept. */
function toRawImage(bitmap: ImageBitmap): RawImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');

  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return new RawImage(new Uint8ClampedArray(data), width, height, 4);
}
