import type { LangCode, Size, TextBlock, TextLine } from '../types';

/**
 * Detection and recognition are separate interfaces on purpose.
 *
 * PP-OCR's detector is language-agnostic — it finds where the ink is, not what
 * it says — so adding English later swaps only the recognizer. manga-ocr reads
 * Japanese and nothing else, which is precisely why it must not be the thing
 * the pipeline depends on.
 */

export interface TextDetector {
  readonly id: string;
  readonly version: string;
  /** Declared so a build check can keep GPL/AGPL models out of a shipped bundle. */
  readonly license: string;
  init(onProgress?: (fraction: number) => void): Promise<void>;
  /** Boxes in the pixel space of the bitmap passed in. */
  detect(bitmap: ImageBitmap, lang: LangCode): Promise<TextLine[]>;
  dispose(): void;
}

export interface TextRecognizer {
  readonly id: string;
  readonly version: string;
  readonly license: string;
  /** Languages this recognizer can actually read. */
  readonly langs: readonly LangCode[];
  init(onProgress?: (fraction: number) => void): Promise<void>;
  /** One call per block; the block is a whole bubble, not a single line. */
  recognize(crop: ImageBitmap, block: TextBlock): Promise<string>;
  dispose(): void;
}

export interface LanguagePack {
  code: LangCode;
  detector: TextDetector;
  recognizer: TextRecognizer;
  rtl: boolean;
}

export class ModelNotDownloadedError extends Error {
  constructor(modelId: string, path: string) {
    super(`Model "${modelId}" not found at ${path}. Run: npm run models`);
    this.name = 'ModelNotDownloadedError';
  }
}

/** Draw a sub-rectangle of a bitmap into a new bitmap, for cropping bubbles. */
export async function cropBitmap(source: ImageBitmap, rect: Size & { x: number; y: number }) {
  return createImageBitmap(
    source,
    Math.round(rect.x),
    Math.round(rect.y),
    Math.max(1, Math.round(rect.w)),
    Math.max(1, Math.round(rect.h)),
  );
}
