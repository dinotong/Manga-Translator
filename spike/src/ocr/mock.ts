import type { LangCode, TextBlock, TextLine } from '../types';
import type { TextDetector, TextRecognizer } from './types';

/**
 * Stand-ins so the harness runs end-to-end before any model is downloaded.
 *
 * The point is to exercise the wiring — decode, grouping, crop, render, timings —
 * against a real image, so that when the ONNX detector lands the only new
 * variable is the ONNX detector. Output is clearly fake and labelled as such in
 * the UI; nothing here should ever be benchmarked.
 */

/** Synthetic columns laid out like a right-to-left page of dialogue. */
export class MockDetector implements TextDetector {
  readonly id = 'mock-detector';
  readonly version = '0';
  readonly license = 'N/A';

  async init(onProgress?: (f: number) => void): Promise<void> {
    onProgress?.(1);
  }

  async detect(bitmap: ImageBitmap, lang: LangCode): Promise<TextLine[]> {
    const { width: w, height: h } = bitmap;
    const vertical = lang === 'ja' || lang === 'zh';
    const lines: TextLine[] = [];

    // Three bubbles, two or three lines each, spread down the page.
    const bubbles = [
      { cx: 0.75, cy: 0.18, lines: 3 },
      { cx: 0.3, cy: 0.45, lines: 2 },
      { cx: 0.6, cy: 0.78, lines: 3 },
    ];

    for (const b of bubbles) {
      const glyph = Math.max(8, Math.round(Math.min(w, h) * 0.028));
      const run = glyph * 7;
      for (let i = 0; i < b.lines; i++) {
        const rect = vertical
          ? {
              x: Math.round(b.cx * w - i * glyph * 1.35),
              y: Math.round(b.cy * h),
              w: glyph,
              h: run,
            }
          : {
              x: Math.round(b.cx * w - run / 2),
              y: Math.round(b.cy * h + i * glyph * 1.6),
              w: run,
              h: glyph,
            };
        lines.push({ rect, score: 0.9, direction: vertical ? 'vertical' : 'horizontal' });
      }
    }

    return lines;
  }

  dispose(): void {}
}

/** Echoes the block's geometry instead of inventing plausible text. */
export class MockRecognizer implements TextRecognizer {
  readonly id = 'mock-recognizer';
  readonly version = '0';
  readonly license = 'N/A';
  readonly langs: readonly LangCode[] = ['ja', 'en', 'ko', 'zh'];

  async init(onProgress?: (f: number) => void): Promise<void> {
    onProgress?.(1);
  }

  async recognize(_crop: ImageBitmap, block: TextBlock): Promise<string> {
    // Deliberately not fake Japanese: a mock that looks like real output is a
    // mock you will eventually mistake for real output.
    const { x, y, w, h } = block.rect;
    return `[mock ${block.direction} ${block.lines.length}L @${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}]`;
  }

  dispose(): void {}
}
