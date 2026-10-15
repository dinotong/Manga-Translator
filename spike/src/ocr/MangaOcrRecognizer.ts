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
 * Model choice: ms57rd/manga-ocr-base-ONNX, and 🔴 that export is broken. See
 * DECISIONS D-012. Two defects, both proven against a synthetic fixture that
 * simply says こんにちは in 64px serif on white:
 *
 *  1. Its tokenizer.json carries five tokens instead of 6144, so every id came
 *     back as [UNK] and every bubble as an empty string. download-models.mjs
 *     now grafts the real vocabulary on from kha-white's original repo.
 *  2. With the vocabulary fixed the model emits fluent-looking Japanese that
 *     has nothing to do with the image, identically at fp32 and int8. Its
 *     "decoder_model_merged" declares no past_key_values inputs at all, so the
 *     name is a lie and the generation loop cannot be running as intended.
 *
 * Defect 2 is not ours to fix from here — it needs a fresh ONNX export from
 * kha-white/manga-ocr-base. Kept wired up because the interface, the ink guards
 * and the timings around it are all still what a Local Service will need.
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
      // generation_config.json asks for 4 beams. do_sample:false alone does not
      // switch that off, and transformers.js has no beam search, so state the
      // greedy intent instead of relying on what it does with a request it
      // cannot honour.
      num_beams: 1,
    });

    const text = firstGeneratedText(output);
    if (!text) {
      // Empty output and a hallucinated sentence cost the same 5 seconds, and
      // from the pipeline's side both just look like "this block vanished".
      // Print the shape so the next person can tell an unreadable crop from a
      // result we failed to unwrap.
      console.warn(`[${this.id}] empty result`, {
        crop: `${crop.width}x${crop.height}`,
        shape: describe(output),
      });
    }
    return text;
  }

  dispose(): void {
    void this.pipe?.dispose();
    this.pipe = null;
  }
}

/**
 * Pull the generated string out of whatever shape the pipeline returned.
 *
 * transformers.js wraps image-to-text results in one array per input image and
 * another per returned sequence, and whether it unwraps the outer one depends
 * on how it decided the input was batched. Reading `output[0].generated_text`
 * therefore works or silently yields undefined depending on the version — and
 * the failure looks exactly like a bubble the model could not read, five
 * seconds of work discarded without a word. Flattening is cheaper than pinning.
 */
function firstGeneratedText(output: unknown): string {
  let node: unknown = output;
  for (let depth = 0; Array.isArray(node) && depth < 4; depth++) node = node[0];
  const text = (node as { generated_text?: unknown } | null)?.generated_text;
  return typeof text === 'string' ? text.trim() : '';
}

/** Shape of a value, without its contents — for logs that must not leak page text. */
function describe(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    return depth > 3 ? 'array' : `array(${value.length})[${describe(value[0], depth + 1)}]`;
  }
  if (value && typeof value === 'object') return `{${Object.keys(value).join(',')}}`;
  return typeof value;
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
